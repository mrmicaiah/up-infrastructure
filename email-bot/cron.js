/**
 * Cron handlers - scheduled tasks
 */

import { generateId, sendEmailViaSES, renderEmail, jsonResponse } from './lib.js';
import { handleSendEmail } from './handlers-emails.js';

/**
 * Calculate the next send time based on step configuration
 * @param {Object} step - The sequence step with delay_minutes and optional send_at_time
 * @param {string} timezone - Timezone string like "America/Chicago" (defaults to UTC)
 * @returns {string} ISO timestamp for next send
 */
function calculateNextSendAt(step, timezone) {
  const now = new Date();
  
  // If no send_at_time, use simple delay from now
  if (!step.send_at_time) {
    return new Date(now.getTime() + (step.delay_minutes || 0) * 60000).toISOString();
  }
  
  // Parse send_at_time (format: "HH:MM" in 24h)
  const [hours, minutes] = step.send_at_time.split(':').map(Number);
  
  // Calculate days to wait (delay_minutes / 1440 minutes per day, minimum 1 day if send_at_time is set)
  const daysToWait = Math.max(1, Math.floor((step.delay_minutes || 1440) / 1440));
  
  // Start with today at the target time in UTC
  // We'll adjust for timezone by converting the target time
  let targetDate = new Date(now);
  targetDate.setUTCHours(hours, minutes, 0, 0);
  
  // Adjust for timezone offset
  // For America/Chicago (CST/CDT), offset is -6 or -5 hours
  // We need to ADD the offset to convert local time to UTC
  const tzOffsets = {
    'America/Chicago': 6,    // CST (winter) - add 6 hours to get UTC
    'America/New_York': 5,   // EST
    'America/Los_Angeles': 8, // PST
    'America/Denver': 7,     // MST
    'UTC': 0
  };
  
  const offsetHours = tzOffsets[timezone] || 0;
  targetDate.setUTCHours(targetDate.getUTCHours() + offsetHours);
  
  // Add the days to wait
  targetDate.setUTCDate(targetDate.getUTCDate() + daysToWait);
  
  // If the calculated time is still in the past (edge case), add another day
  if (targetDate <= now) {
    targetDate.setUTCDate(targetDate.getUTCDate() + 1);
  }
  
  return targetDate.toISOString();
}

export async function processSequenceEmails(env) {
  const results = { processed: 0, sent: 0, failed: 0, errors: [] };
  
  try {
    // Use strftime to get ISO format for proper comparison with stored timestamps
    const due = await env.DB.prepare(`
      SELECT e.id as enrollment_id, e.sequence_id, e.current_step, e.subscription_id,
             ss.id as step_id, ss.subject, ss.preview_text, ss.body_html, ss.body_text, ss.delay_minutes, ss.send_at_time,
             sub.lead_id, l.email, l.name,
             seq.list_id, seq.send_timezone, lst.from_name, lst.from_email, lst.sequence_template_id
      FROM sequence_enrollments e
      JOIN sequence_steps ss ON ss.sequence_id = e.sequence_id AND ss.position = e.current_step + 1
      JOIN subscriptions sub ON sub.id = e.subscription_id
      JOIN leads l ON l.id = sub.lead_id
      JOIN sequences seq ON seq.id = e.sequence_id
      JOIN lists lst ON lst.id = seq.list_id
      WHERE e.status = 'active'
        AND e.next_send_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        AND ss.status = 'active'
        AND sub.status = 'active'
      LIMIT 50
    `).all();
    
    results.found = due.results?.length || 0;
    
    if (!due.results || due.results.length === 0) {
      return results;
    }
    
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    
    // Cache templates to avoid repeated lookups
    const templateCache = {};
    
    for (const enrollment of due.results) {
      results.processed++;
      try {
        // Fetch sequence template if list has one (with caching)
        let template = null;
        if (enrollment.sequence_template_id) {
          if (!templateCache[enrollment.sequence_template_id]) {
            templateCache[enrollment.sequence_template_id] = await env.DB.prepare(
              'SELECT * FROM templates WHERE id = ?'
            ).bind(enrollment.sequence_template_id).first();
          }
          template = templateCache[enrollment.sequence_template_id];
        }
        
        const sendId = generateId();
        const subscriber = { email: enrollment.email, name: enrollment.name };
        const emailObj = {
          subject: enrollment.subject,
          body_html: enrollment.body_html,
          body_text: enrollment.body_text
        };
        const list = {
          from_name: enrollment.from_name,
          from_email: enrollment.from_email
        };
        
        const renderedHtml = renderEmail(emailObj, subscriber, sendId, baseUrl, list, template);
        
        await sendEmailViaSES(
          env,
          enrollment.email,
          enrollment.subject,
          renderedHtml,
          enrollment.body_text,
          enrollment.from_name,
          enrollment.from_email
        );
        
        // For sequence emails, don't use foreign key - just log the send
        await env.DB.prepare(`
          INSERT INTO email_sends (id, email_id, lead_id, subscription_id, status, created_at)
          VALUES (?, NULL, ?, ?, 'sent', ?)
        `).bind(sendId, enrollment.lead_id, enrollment.subscription_id, new Date().toISOString()).run();
        
        // Check for next step
        const nextStep = await env.DB.prepare(`
          SELECT * FROM sequence_steps 
          WHERE sequence_id = ? AND position = ? AND status = 'active'
        `).bind(enrollment.sequence_id, enrollment.current_step + 2).first();
        
        if (nextStep) {
          // Calculate next send time using the step's send_at_time if available
          const nextSendAt = calculateNextSendAt(nextStep, enrollment.send_timezone || 'America/Chicago');
          
          await env.DB.prepare(`
            UPDATE sequence_enrollments 
            SET current_step = current_step + 1, next_send_at = ?
            WHERE id = ?
          `).bind(nextSendAt, enrollment.enrollment_id).run();
        } else {
          await env.DB.prepare(`
            UPDATE sequence_enrollments 
            SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), current_step = current_step + 1
            WHERE id = ?
          `).bind(enrollment.enrollment_id).run();
        }
        
        results.sent++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          enrollment_id: enrollment.enrollment_id,
          email: enrollment.email,
          error: error.message
        });
        console.error('Sequence email failed:', enrollment.enrollment_id, error);
      }
    }
  } catch (error) {
    results.errors.push({ stage: 'query', error: error.message });
    console.error('Process sequence emails error:', error);
  }
  
  return results;
}

export async function processScheduledCampaigns(env) {
  const results = { processed: 0, sent: 0, failed: 0, errors: [] };
  
  try {
    // Use strftime for consistent ISO format comparison
    const due = await env.DB.prepare(`
      SELECT id FROM emails 
      WHERE status = 'scheduled' AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).all();
    
    results.found = due.results?.length || 0;
    
    if (!due.results || due.results.length === 0) {
      return results;
    }
    
    for (const campaign of due.results) {
      results.processed++;
      try {
        await handleSendEmail(campaign.id, null, env);
        results.sent++;
        console.log('Scheduled campaign sent:', campaign.id);
      } catch (error) {
        results.failed++;
        results.errors.push({ campaign_id: campaign.id, error: error.message });
        console.error('Scheduled campaign failed:', campaign.id, error);
      }
    }
  } catch (error) {
    results.errors.push({ stage: 'query', error: error.message });
    console.error('Process scheduled campaigns error:', error);
  }
  
  return results;
}

// Manual trigger endpoint for debugging
export async function handleProcessSequences(request, env) {
  try {
    // First, show what the query would find
    const debug = await env.DB.prepare(`
      SELECT 
        e.id as enrollment_id, 
        e.status as enrollment_status,
        e.current_step,
        e.next_send_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now') as current_time,
        e.next_send_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') as is_due,
        ss.id as step_id,
        ss.position as step_position,
        ss.status as step_status,
        ss.subject,
        ss.send_at_time,
        sub.status as subscription_status,
        l.email,
        seq.status as sequence_status,
        seq.send_timezone
      FROM sequence_enrollments e
      LEFT JOIN sequence_steps ss ON ss.sequence_id = e.sequence_id AND ss.position = e.current_step + 1
      LEFT JOIN subscriptions sub ON sub.id = e.subscription_id
      LEFT JOIN leads l ON l.id = sub.lead_id
      LEFT JOIN sequences seq ON seq.id = e.sequence_id
      WHERE e.status = 'active'
      LIMIT 10
    `).all();
    
    // Run the actual processing
    const sequenceResults = await processSequenceEmails(env);
    const campaignResults = await processScheduledCampaigns(env);
    
    return jsonResponse({
      success: true,
      debug_enrollments: debug.results,
      sequences: sequenceResults,
      campaigns: campaignResults,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message,
      stack: error.stack
    }, 500);
  }
}

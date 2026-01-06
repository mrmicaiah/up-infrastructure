/**
 * Cron handlers - scheduled tasks
 */

import { generateId, sendEmailViaSES, renderEmail, jsonResponse } from './lib.js';
import { handleSendEmail } from './handlers-emails.js';

export async function processSequenceEmails(env) {
  const results = { processed: 0, sent: 0, failed: 0, errors: [] };
  
  try {
    // Use strftime to get ISO format for proper comparison with stored timestamps
    const due = await env.DB.prepare(`
      SELECT e.id as enrollment_id, e.sequence_id, e.current_step, e.subscription_id,
             ss.id as step_id, ss.subject, ss.preview_text, ss.body_html, ss.body_text, ss.delay_minutes,
             sub.lead_id, l.email, l.name,
             seq.list_id, lst.from_name, lst.from_email
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
    
    for (const enrollment of due.results) {
      results.processed++;
      try {
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
        
        const renderedHtml = renderEmail(emailObj, subscriber, sendId, baseUrl, list);
        
        await sendEmailViaSES(
          env,
          enrollment.email,
          enrollment.subject,
          renderedHtml,
          enrollment.body_text,
          enrollment.from_name,
          enrollment.from_email
        );
        
        await env.DB.prepare(`
          INSERT INTO email_sends (id, email_id, lead_id, subscription_id, status, created_at)
          VALUES (?, ?, ?, ?, 'sent', ?)
        `).bind(sendId, enrollment.step_id, enrollment.lead_id, enrollment.subscription_id, new Date().toISOString()).run();
        
        const nextStep = await env.DB.prepare(`
          SELECT * FROM sequence_steps 
          WHERE sequence_id = ? AND position = ? AND status = 'active'
        `).bind(enrollment.sequence_id, enrollment.current_step + 2).first();
        
        if (nextStep) {
          const nextSendAt = new Date(Date.now() + nextStep.delay_minutes * 60000).toISOString();
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
        sub.status as subscription_status,
        l.email,
        seq.status as sequence_status
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

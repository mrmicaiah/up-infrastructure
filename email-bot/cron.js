/**
 * Cron handlers - scheduled tasks
 */

import { generateId, sendEmailViaSES, renderEmail, jsonResponse } from './lib.js';
import { handleSendEmail } from './handlers-emails.js';

export async function processSequenceEmails(env, debug = false) {
  const debugLog = [];
  
  try {
    debugLog.push(`Starting processSequenceEmails at ${new Date().toISOString()}`);
    
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
        AND e.next_send_at <= datetime('now')
        AND ss.status = 'active'
        AND sub.status = 'active'
      LIMIT 50
    `).all();
    
    debugLog.push(`Found ${due.results?.length || 0} enrollments due`);
    
    if (!due.results || due.results.length === 0) {
      if (debug) {
        // Also check what enrollments exist at all
        const allEnrollments = await env.DB.prepare(`
          SELECT e.*, datetime('now') as db_now
          FROM sequence_enrollments e
          WHERE e.status = 'active'
          LIMIT 10
        `).all();
        debugLog.push(`Active enrollments: ${JSON.stringify(allEnrollments.results)}`);
      }
      return debug ? { success: true, log: debugLog, sent: 0 } : undefined;
    }
    
    const baseUrl = 'https://email-bot-server.micaiah-tasks.workers.dev';
    let sentCount = 0;
    
    for (const enrollment of due.results) {
      try {
        debugLog.push(`Processing: ${enrollment.email} - ${enrollment.subject}`);
        
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
        
        debugLog.push(`Sending via SES from ${enrollment.from_email}...`);
        
        await sendEmailViaSES(
          env,
          enrollment.email,
          enrollment.subject,
          renderedHtml,
          enrollment.body_text,
          enrollment.from_name,
          enrollment.from_email
        );
        
        debugLog.push(`SES send successful for ${enrollment.email}`);
        
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
          debugLog.push(`Advanced to step ${enrollment.current_step + 1}, next send at ${nextSendAt}`);
        } else {
          await env.DB.prepare(`
            UPDATE sequence_enrollments 
            SET status = 'completed', completed_at = datetime('now'), current_step = current_step + 1
            WHERE id = ?
          `).bind(enrollment.enrollment_id).run();
          debugLog.push(`Completed sequence for ${enrollment.email}`);
        }
        
        sentCount++;
      } catch (error) {
        debugLog.push(`ERROR for ${enrollment.email}: ${error.message}`);
        console.error('Sequence email failed:', enrollment.enrollment_id, error);
      }
    }
    
    debugLog.push(`Completed. Sent ${sentCount} emails.`);
    return debug ? { success: true, log: debugLog, sent: sentCount } : undefined;
    
  } catch (error) {
    debugLog.push(`FATAL ERROR: ${error.message}`);
    console.error('Process sequence emails error:', error);
    return debug ? { success: false, log: debugLog, error: error.message } : undefined;
  }
}

export async function processScheduledCampaigns(env) {
  try {
    const due = await env.DB.prepare(`
      SELECT id FROM emails 
      WHERE status = 'scheduled' AND scheduled_at <= datetime('now')
    `).all();
    
    if (!due.results || due.results.length === 0) return;
    
    for (const campaign of due.results) {
      try {
        await handleSendEmail(campaign.id, null, env);
        console.log('Scheduled campaign sent:', campaign.id);
      } catch (error) {
        console.error('Scheduled campaign failed:', campaign.id, error);
      }
    }
  } catch (error) {
    console.error('Process scheduled campaigns error:', error);
  }
}

// Manual trigger endpoint handler
export async function handleProcessSequences(request, env) {
  const result = await processSequenceEmails(env, true);
  return jsonResponse(result);
}

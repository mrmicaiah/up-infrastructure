// Google Analytics tools

import { z } from "zod";
import type { ToolContext } from '../types';
import { getValidToken } from '../oauth';

const ANALYTICS_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

export function registerAnalyticsTools(ctx: ToolContext) {
  const { server, env, getCurrentUser } = ctx;

  // List configured GA4 properties
  server.tool("analytics_properties", {}, async () => {
    const userId = getCurrentUser();
    
    // Check if analytics is connected
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected. Run `connect_service google_analytics` to connect." }] };
    }
    
    const properties = await env.DB.prepare(
      'SELECT * FROM analytics_properties WHERE user_id = ? ORDER BY name'
    ).bind(userId).all();
    
    if (!properties.results || properties.results.length === 0) {
      return { content: [{ type: "text", text: "📊 No GA4 properties configured yet.\n\nUse `analytics_add_property` to add a property:\n- property_id: Your GA4 property ID (numeric, e.g., 123456789)\n- name: A friendly name for the property\n- blog_id: (optional) Link to a Blogger blog ID" }] };
    }
    
    let output = '📊 **Configured GA4 Properties**\n\n';
    for (const prop of properties.results as any[]) {
      output += `• **${prop.name}**\n`;
      output += `  Property ID: ${prop.property_id}\n`;
      if (prop.blog_id) output += `  Linked Blog: ${prop.blog_id}\n`;
      output += '\n';
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Add a GA4 property
  server.tool("analytics_add_property", {
    property_id: z.string().describe("GA4 property ID (numeric, e.g., 123456789)"),
    name: z.string().describe("Friendly name for this property"),
    blog_id: z.string().optional().describe("Optional Blogger blog ID to link")
  }, async ({ property_id, name, blog_id }) => {
    const userId = getCurrentUser();
    
    // Check if analytics is connected
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected. Run `connect_service google_analytics` first." }] };
    }
    
    // Verify the property ID works by making a test request
    const testResponse = await fetch(`${ANALYTICS_DATA_API}/properties/${property_id}:runReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'activeUsers' }],
        limit: 1
      })
    });
    
    if (!testResponse.ok) {
      const error = await testResponse.text();
      return { content: [{ type: "text", text: `❌ Failed to verify property ${property_id}.\n\nMake sure:\n1. The property ID is correct (numeric only, no "G-" prefix)\n2. Your Google account has access to this GA4 property\n\nError: ${error}` }] };
    }
    
    // Save the property
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO analytics_properties (id, user_id, property_id, name, blog_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, property_id, name, blog_id || null, new Date().toISOString()).run();
    
    return { content: [{ type: "text", text: `✅ Added GA4 property "${name}" (${property_id})${blog_id ? ` linked to blog ${blog_id}` : ''}` }] };
  });

  // Remove a GA4 property
  server.tool("analytics_remove_property", {
    property_id: z.string().describe("GA4 property ID to remove")
  }, async ({ property_id }) => {
    const userId = getCurrentUser();
    
    const result = await env.DB.prepare(
      'DELETE FROM analytics_properties WHERE user_id = ? AND property_id = ?'
    ).bind(userId, property_id).run();
    
    if (result.meta.changes === 0) {
      return { content: [{ type: "text", text: `⚠️ Property ${property_id} not found.` }] };
    }
    
    return { content: [{ type: "text", text: `🗑️ Removed property ${property_id}` }] };
  });

  // Get analytics report
  server.tool("analytics_report", {
    property_id: z.string().optional().describe("GA4 property ID (uses first configured if not specified)"),
    days: z.number().default(7).describe("Number of days to report on (default: 7)"),
    metrics: z.array(z.string()).optional().describe("Metrics to include (default: screenPageViews, sessions, activeUsers)")
  }, async ({ property_id, days, metrics }) => {
    const userId = getCurrentUser();
    
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected. Run `connect_service google_analytics` to connect." }] };
    }
    
    // Get property ID
    let propId = property_id;
    if (!propId) {
      const prop = await env.DB.prepare(
        'SELECT property_id FROM analytics_properties WHERE user_id = ? LIMIT 1'
      ).bind(userId).first() as any;
      
      if (!prop) {
        return { content: [{ type: "text", text: "❌ No GA4 properties configured. Use `analytics_add_property` first." }] };
      }
      propId = prop.property_id;
    }
    
    const metricsToFetch = metrics || ['screenPageViews', 'sessions', 'activeUsers', 'bounceRate', 'averageSessionDuration'];
    
    const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propId}:runReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: metricsToFetch.map(m => ({ name: m })),
        orderBys: [{ dimension: { orderType: 'ALPHANUMERIC', dimensionName: 'date' } }]
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `❌ Failed to fetch analytics: ${error}` }] };
    }
    
    const data: any = await response.json();
    
    // Calculate totals
    const totals: Record<string, number> = {};
    for (const metric of metricsToFetch) {
      totals[metric] = 0;
    }
    
    if (data.rows) {
      for (const row of data.rows) {
        row.metricValues.forEach((val: any, i: number) => {
          totals[metricsToFetch[i]] += parseFloat(val.value) || 0;
        });
      }
    }
    
    // Format output
    let output = `📊 **Analytics Report** (Last ${days} days)\n`;
    output += `Property: ${propId}\n\n`;
    
    output += '**Summary:**\n';
    if (totals.screenPageViews !== undefined) output += `• Page Views: ${Math.round(totals.screenPageViews).toLocaleString()}\n`;
    if (totals.sessions !== undefined) output += `• Sessions: ${Math.round(totals.sessions).toLocaleString()}\n`;
    if (totals.activeUsers !== undefined) output += `• Active Users: ${Math.round(totals.activeUsers).toLocaleString()}\n`;
    if (totals.bounceRate !== undefined) output += `• Bounce Rate: ${(totals.bounceRate / (data.rows?.length || 1) * 100).toFixed(1)}%\n`;
    if (totals.averageSessionDuration !== undefined) {
      const avgDuration = totals.averageSessionDuration / (data.rows?.length || 1);
      const mins = Math.floor(avgDuration / 60);
      const secs = Math.round(avgDuration % 60);
      output += `• Avg Session: ${mins}m ${secs}s\n`;
    }
    
    // Daily breakdown
    if (data.rows && data.rows.length > 0) {
      output += '\n**Daily Breakdown:**\n';
      for (const row of data.rows.slice(-7)) {
        const date = row.dimensionValues[0].value;
        const formattedDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        const views = Math.round(parseFloat(row.metricValues[0]?.value || 0));
        const users = Math.round(parseFloat(row.metricValues[2]?.value || 0));
        output += `• ${formattedDate}: ${views} views, ${users} users\n`;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Get top content
  server.tool("analytics_top_content", {
    property_id: z.string().optional().describe("GA4 property ID"),
    days: z.number().default(30).describe("Number of days (default: 30)"),
    limit: z.number().default(10).describe("Number of pages to show (default: 10)")
  }, async ({ property_id, days, limit }) => {
    const userId = getCurrentUser();
    
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected." }] };
    }
    
    let propId = property_id;
    if (!propId) {
      const prop = await env.DB.prepare(
        'SELECT property_id FROM analytics_properties WHERE user_id = ? LIMIT 1'
      ).bind(userId).first() as any;
      if (!prop) {
        return { content: [{ type: "text", text: "❌ No GA4 properties configured." }] };
      }
      propId = prop.property_id;
    }
    
    const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propId}:runReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: limit
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `❌ Failed to fetch top content: ${error}` }] };
    }
    
    const data: any = await response.json();
    
    let output = `📈 **Top Content** (Last ${days} days)\n\n`;
    
    if (!data.rows || data.rows.length === 0) {
      output += 'No data available for this period.';
    } else {
      let rank = 1;
      for (const row of data.rows) {
        const title = row.dimensionValues[0].value || 'Untitled';
        const path = row.dimensionValues[1].value;
        const views = Math.round(parseFloat(row.metricValues[0].value));
        const users = Math.round(parseFloat(row.metricValues[1].value));
        const duration = parseFloat(row.metricValues[2].value);
        const durationStr = duration > 60 ? `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s` : `${Math.round(duration)}s`;
        
        output += `**${rank}.** ${title}\n`;
        output += `   📄 ${path}\n`;
        output += `   👁️ ${views.toLocaleString()} views • 👤 ${users} users • ⏱️ ${durationStr}\n\n`;
        rank++;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Get traffic sources
  server.tool("analytics_sources", {
    property_id: z.string().optional().describe("GA4 property ID"),
    days: z.number().default(30).describe("Number of days (default: 30)")
  }, async ({ property_id, days }) => {
    const userId = getCurrentUser();
    
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected." }] };
    }
    
    let propId = property_id;
    if (!propId) {
      const prop = await env.DB.prepare(
        'SELECT property_id FROM analytics_properties WHERE user_id = ? LIMIT 1'
      ).bind(userId).first() as any;
      if (!prop) {
        return { content: [{ type: "text", text: "❌ No GA4 properties configured." }] };
      }
      propId = prop.property_id;
    }
    
    const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propId}:runReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'bounceRate' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 15
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `❌ Failed to fetch traffic sources: ${error}` }] };
    }
    
    const data: any = await response.json();
    
    let output = `🔗 **Traffic Sources** (Last ${days} days)\n\n`;
    
    if (!data.rows || data.rows.length === 0) {
      output += 'No data available for this period.';
    } else {
      for (const row of data.rows) {
        const source = row.dimensionValues[0].value || '(direct)';
        const medium = row.dimensionValues[1].value || '(none)';
        const sessions = Math.round(parseFloat(row.metricValues[0].value));
        const users = Math.round(parseFloat(row.metricValues[1].value));
        const bounceRate = (parseFloat(row.metricValues[2].value) * 100).toFixed(1);
        
        output += `• **${source}** / ${medium}\n`;
        output += `  ${sessions.toLocaleString()} sessions • ${users} users • ${bounceRate}% bounce\n\n`;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Get geographic data
  server.tool("analytics_geography", {
    property_id: z.string().optional().describe("GA4 property ID"),
    days: z.number().default(30).describe("Number of days (default: 30)")
  }, async ({ property_id, days }) => {
    const userId = getCurrentUser();
    
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected." }] };
    }
    
    let propId = property_id;
    if (!propId) {
      const prop = await env.DB.prepare(
        'SELECT property_id FROM analytics_properties WHERE user_id = ? LIMIT 1'
      ).bind(userId).first() as any;
      if (!prop) {
        return { content: [{ type: "text", text: "❌ No GA4 properties configured." }] };
      }
      propId = prop.property_id;
    }
    
    const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propId}:runReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'country' }, { name: 'city' }],
        metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 20
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `❌ Failed to fetch geography data: ${error}` }] };
    }
    
    const data: any = await response.json();
    
    let output = `🌍 **Geographic Distribution** (Last ${days} days)\n\n`;
    
    if (!data.rows || data.rows.length === 0) {
      output += 'No data available for this period.';
    } else {
      // Group by country
      const byCountry: Record<string, { users: number; sessions: number; cities: string[] }> = {};
      
      for (const row of data.rows) {
        const country = row.dimensionValues[0].value || 'Unknown';
        const city = row.dimensionValues[1].value || 'Unknown';
        const users = Math.round(parseFloat(row.metricValues[0].value));
        const sessions = Math.round(parseFloat(row.metricValues[1].value));
        
        if (!byCountry[country]) {
          byCountry[country] = { users: 0, sessions: 0, cities: [] };
        }
        byCountry[country].users += users;
        byCountry[country].sessions += sessions;
        if (city !== '(not set)' && !byCountry[country].cities.includes(city)) {
          byCountry[country].cities.push(city);
        }
      }
      
      // Sort by users
      const sorted = Object.entries(byCountry).sort((a, b) => b[1].users - a[1].users);
      
      for (const [country, countryData] of sorted.slice(0, 10)) {
        output += `🏳️ **${country}**\n`;
        output += `   ${countryData.users.toLocaleString()} users • ${countryData.sessions.toLocaleString()} sessions\n`;
        if (countryData.cities.length > 0) {
          output += `   Cities: ${countryData.cities.slice(0, 3).join(', ')}${countryData.cities.length > 3 ? '...' : ''}\n`;
        }
        output += '\n';
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  });

  // Real-time active users
  server.tool("analytics_realtime", {
    property_id: z.string().optional().describe("GA4 property ID")
  }, async ({ property_id }) => {
    const userId = getCurrentUser();
    
    const token = await getValidToken(env, userId, 'google_analytics');
    if (!token) {
      return { content: [{ type: "text", text: "❌ Google Analytics not connected." }] };
    }
    
    let propId = property_id;
    if (!propId) {
      const prop = await env.DB.prepare(
        'SELECT property_id FROM analytics_properties WHERE user_id = ? LIMIT 1'
      ).bind(userId).first() as any;
      if (!prop) {
        return { content: [{ type: "text", text: "❌ No GA4 properties configured." }] };
      }
      propId = prop.property_id;
    }
    
    const response = await fetch(`${ANALYTICS_DATA_API}/properties/${propId}:runRealtimeReport`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'activeUsers' }]
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `❌ Failed to fetch realtime data: ${error}` }] };
    }
    
    const data: any = await response.json();
    
    let totalUsers = 0;
    const countries: string[] = [];
    
    if (data.rows) {
      for (const row of data.rows) {
        const users = parseInt(row.metricValues[0].value);
        totalUsers += users;
        const country = row.dimensionValues[0].value;
        if (country && country !== '(not set)') {
          countries.push(`${country} (${users})`);
        }
      }
    }
    
    let output = `⚡ **Real-time Activity**\n\n`;
    output += `**Active Users Now:** ${totalUsers}\n\n`;
    
    if (countries.length > 0) {
      output += `**By Country:**\n${countries.slice(0, 10).join('\n')}\n`;
    }
    
    return { content: [{ type: "text", text: output }] };
  });
}

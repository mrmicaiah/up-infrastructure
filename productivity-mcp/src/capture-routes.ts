// capture-routes.ts - API endpoints for Capture Portal PWA

interface CaptureEnv {
  DB: D1Database;
  USER_ID: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Portal-Session',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function createCaptureRoutes(env: CaptureEnv) {
  const db = env.DB;

  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const path = url.pathname.replace('/api', '');
      const method = request.method;

      // Only handle /capture/* routes
      if (!path.startsWith('/capture/')) {
        return null;
      }

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // POST /api/capture/auth - Authenticate client with slug (PIN optional)
        if (path === '/capture/auth' && method === 'POST') {
          const body = await request.json() as any;
          const { slug, pin } = body;
          
          if (!slug) {
            return jsonResponse({ error: 'slug required' }, 400);
          }
          
          const portal = await db.prepare(
            'SELECT * FROM capture_portals WHERE client_slug = ? AND status = ?'
          ).bind(slug, 'active').first() as any;
          
          if (!portal) {
            return jsonResponse({ error: 'Portal not found' }, 404);
          }
          
          // Only validate PIN if portal has one set and it's not empty
          if (portal.pin && portal.pin.trim() !== '' && portal.pin !== pin) {
            return jsonResponse({ error: 'Invalid PIN' }, 401);
          }
          
          return jsonResponse({
            success: true,
            portal_id: portal.id,
            portal_name: portal.client_name,
            cloudinary_folder: portal.cloudinary_folder
          });
        }
        
        // POST /api/capture/upload - Upload image to Cloudinary
        if (path === '/capture/upload' && method === 'POST') {
          const contentType = request.headers.get('Content-Type') || '';
          
          if (!contentType.includes('multipart/form-data')) {
            return jsonResponse({ error: 'multipart/form-data required' }, 400);
          }
          
          const formData = await request.formData();
          const portalId = formData.get('portal_id') as string;
          const image = formData.get('image') as File;
          
          if (!portalId || !image) {
            return jsonResponse({ error: 'portal_id and image required' }, 400);
          }
          
          // Verify portal exists
          const portal = await db.prepare(
            'SELECT * FROM capture_portals WHERE id = ? AND status = ?'
          ).bind(portalId, 'active').first() as any;
          
          if (!portal) {
            return jsonResponse({ error: 'Portal not found or inactive' }, 404);
          }
          
          // Check Cloudinary credentials
          if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
            return jsonResponse({ error: 'Cloudinary not configured' }, 500);
          }
          
          // Upload to Cloudinary
          const timestamp = Math.floor(Date.now() / 1000);
          const folder = portal.cloudinary_folder;
          
          // Create signature for Cloudinary
          const signatureString = `folder=${folder}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
          const encoder = new TextEncoder();
          const data = encoder.encode(signatureString);
          const hashBuffer = await crypto.subtle.digest('SHA-1', data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          
          // Build upload form
          const uploadForm = new FormData();
          uploadForm.append('file', image);
          uploadForm.append('folder', folder);
          uploadForm.append('timestamp', timestamp.toString());
          uploadForm.append('api_key', env.CLOUDINARY_API_KEY);
          uploadForm.append('signature', signature);
          
          const cloudinaryResp = await fetch(
            `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
            { method: 'POST', body: uploadForm }
          );
          
          if (!cloudinaryResp.ok) {
            const error = await cloudinaryResp.text();
            console.error('Cloudinary error:', error);
            return jsonResponse({ error: 'Upload failed' }, 500);
          }
          
          const cloudinaryData: any = await cloudinaryResp.json();
          
          // Generate thumbnail URL
          const thumbnailUrl = cloudinaryData.secure_url.replace('/upload/', '/upload/c_thumb,w_200,h_200/');
          
          // Save to database
          const uploadId = crypto.randomUUID();
          await db.prepare(`
            INSERT INTO capture_uploads (id, portal_id, cloudinary_public_id, cloudinary_url, thumbnail_url, original_filename, file_size, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).bind(
            uploadId,
            portalId,
            cloudinaryData.public_id,
            cloudinaryData.secure_url,
            thumbnailUrl,
            image.name || 'upload.jpg',
            cloudinaryData.bytes || image.size
          ).run();
          
          return jsonResponse({
            success: true,
            id: uploadId,
            public_id: cloudinaryData.public_id,
            url: cloudinaryData.secure_url,
            thumbnail_url: thumbnailUrl
          });
        }
        
        // GET /api/capture/recent - Get recent uploads for a portal
        if (path === '/capture/recent' && method === 'GET') {
          const portalId = url.searchParams.get('portal_id');
          const limit = parseInt(url.searchParams.get('limit') || '20');
          
          if (!portalId) {
            return jsonResponse({ error: 'portal_id required' }, 400);
          }
          
          const uploads = await db.prepare(`
            SELECT id, thumbnail_url, cloudinary_url, original_filename, uploaded_at
            FROM capture_uploads
            WHERE portal_id = ?
            ORDER BY uploaded_at DESC
            LIMIT ?
          `).bind(portalId, limit).all();
          
          return jsonResponse({ uploads: uploads.results || [] });
        }
        
        // GET /api/capture/stats - Get upload stats for a portal
        if (path === '/capture/stats' && method === 'GET') {
          const portalId = url.searchParams.get('portal_id');
          
          if (!portalId) {
            return jsonResponse({ error: 'portal_id required' }, 400);
          }
          
          const total = await db.prepare(
            'SELECT COUNT(*) as count FROM capture_uploads WHERE portal_id = ?'
          ).bind(portalId).first() as any;
          
          const thisMonth = await db.prepare(`
            SELECT COUNT(*) as count FROM capture_uploads 
            WHERE portal_id = ? AND uploaded_at >= date('now', 'start of month')
          `).bind(portalId).first() as any;
          
          return jsonResponse({
            total_uploads: total?.count || 0,
            this_month: thisMonth?.count || 0
          });
        }

        // No matching capture route
        return null;

      } catch (err: any) {
        console.error('Capture API Error:', err);
        return jsonResponse({ error: err.message || 'Internal error' }, 500);
      }
    }
  };
}

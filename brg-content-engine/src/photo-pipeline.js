/**
 * Photo Pipeline Module
 * 
 * Downloads photos from Jobber (authenticated) and uploads to Cloudinary.
 * Returns public CDN URLs with optimized transforms.
 */

const CLOUDINARY_CLOUD_NAME = 'dxzw1zwez';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
const CLOUDINARY_BASE_URL = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload`;
const DEFAULT_FOLDER = 'blue-river-gutters/projects';

export async function processJobPhotos(accessToken, jobData, env) {
  if (!jobData.photos || jobData.photos.length === 0) {
    return [];
  }
  console.log(`Processing ${jobData.photos.length} photos for job ${jobData.jobNumber}`);
  const folderPath = `${DEFAULT_FOLDER}/${jobData.jobNumber || jobData.id}`;
  const results = [];
  for (const photo of jobData.photos) {
    try {
      const result = await processPhoto(accessToken, photo, folderPath, env);
      results.push({ 
        ...photo, 
        cloudinaryUrl: result.url, 
        cloudinarySecureUrl: result.secure_url, 
        cloudinaryPublicId: result.public_id, 
        optimizedUrl: getOptimizedUrl(result.public_id), 
        thumbnailUrl: getThumbnailUrl(result.public_id), 
        processed: true 
      });
    } catch (error) {
      results.push({ ...photo, processed: false, error: error.message });
    }
  }
  return results;
}

async function processPhoto(accessToken, photo, folderPath, env) {
  const imageData = await downloadFromJobber(accessToken, photo.url);
  const base64DataUri = toBase64DataUri(imageData, photo.contentType);
  const publicId = generatePublicId(photo.fileName);
  return await uploadToCloudinary(base64DataUri, publicId, folderPath, env);
}

async function downloadFromJobber(accessToken, url) {
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return await response.arrayBuffer();
}

function toBase64DataUri(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${contentType || 'image/jpeg'};base64,${btoa(binary)}`;
}

function generatePublicId(fileName) {
  const baseName = fileName.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${baseName}-${Date.now()}`;
}

async function uploadToCloudinary(base64DataUri, publicId, folder, env) {
  if (!env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary credentials not configured');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, public_id: publicId, timestamp: timestamp.toString() };
  const signature = generateSignature(params, env.CLOUDINARY_API_SECRET);
  
  const formData = new FormData();
  formData.append('file', base64DataUri);
  formData.append('api_key', env.CLOUDINARY_API_KEY);
  formData.append('timestamp', timestamp.toString());
  formData.append('signature', signature);
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  
  const response = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: formData });
  if (!response.ok) throw new Error(`Cloudinary upload failed: ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result;
}

function generateSignature(params, secret) {
  const str = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + secret;
  return sha1(str);
}

// SHA-1 implementation for Cloudinary signature
function sha1(str) {
  function rotl(n,s){return(n<<s)|(n>>>(32-s));}
  function hex(v){let s='';for(let i=7;i>=0;i--)s+=((v>>>(i*4))&0xf).toString(16);return s;}
  const utf8=unescape(encodeURIComponent(str)),len=utf8.length,W=[];
  let H0=0x67452301,H1=0xEFCDAB89,H2=0x98BADCFE,H3=0x10325476,H4=0xC3D2E1F0,A,B,C,D,E,t;
  const words=[];
  for(let i=0;i<len-3;i+=4)words.push((utf8.charCodeAt(i)<<24)|(utf8.charCodeAt(i+1)<<16)|(utf8.charCodeAt(i+2)<<8)|utf8.charCodeAt(i+3));
  switch(len%4){
    case 0:words.push(0x80000000);break;
    case 1:words.push((utf8.charCodeAt(len-1)<<24)|0x800000);break;
    case 2:words.push((utf8.charCodeAt(len-2)<<24)|(utf8.charCodeAt(len-1)<<16)|0x8000);break;
    case 3:words.push((utf8.charCodeAt(len-3)<<24)|(utf8.charCodeAt(len-2)<<16)|(utf8.charCodeAt(len-1)<<8)|0x80);break;
  }
  while((words.length%16)!==14)words.push(0);
  words.push(len>>>29);words.push((len<<3)&0xffffffff);
  for(let b=0;b<words.length;b+=16){
    for(let i=0;i<16;i++)W[i]=words[b+i];
    for(let i=16;i<80;i++)W[i]=rotl(W[i-3]^W[i-8]^W[i-14]^W[i-16],1);
    A=H0;B=H1;C=H2;D=H3;E=H4;
    for(let i=0;i<20;i++){t=(rotl(A,5)+((B&C)|(~B&D))+E+W[i]+0x5A827999)&0xffffffff;E=D;D=C;C=rotl(B,30);B=A;A=t;}
    for(let i=20;i<40;i++){t=(rotl(A,5)+(B^C^D)+E+W[i]+0x6ED9EBA1)&0xffffffff;E=D;D=C;C=rotl(B,30);B=A;A=t;}
    for(let i=40;i<60;i++){t=(rotl(A,5)+((B&C)|(B&D)|(C&D))+E+W[i]+0x8F1BBCDC)&0xffffffff;E=D;D=C;C=rotl(B,30);B=A;A=t;}
    for(let i=60;i<80;i++){t=(rotl(A,5)+(B^C^D)+E+W[i]+0xCA62C1D6)&0xffffffff;E=D;D=C;C=rotl(B,30);B=A;A=t;}
    H0=(H0+A)&0xffffffff;H1=(H1+B)&0xffffffff;H2=(H2+C)&0xffffffff;H3=(H3+D)&0xffffffff;H4=(H4+E)&0xffffffff;
  }
  return(hex(H0)+hex(H1)+hex(H2)+hex(H3)+hex(H4)).toLowerCase();
}

// URL generation helpers
export function getOptimizedUrl(publicId) {
  return `${CLOUDINARY_BASE_URL}/f_auto,q_auto/${publicId}`;
}

export function getThumbnailUrl(publicId) {
  return `${CLOUDINARY_BASE_URL}/c_fill,w_300,h_300,f_auto,q_auto/${publicId}`;
}

export function getHeroUrl(publicId) {
  return `${CLOUDINARY_BASE_URL}/c_scale,w_1200,f_auto,q_auto/${publicId}`;
}

export function getGalleryUrl(publicId) {
  return `${CLOUDINARY_BASE_URL}/c_scale,w_800,f_auto,q_auto/${publicId}`;
}

export function getCustomUrl(publicId, width, height = null, crop = 'scale') {
  let transforms = `c_${crop},w_${width}`;
  if (height) transforms += `,h_${height}`;
  return `${CLOUDINARY_BASE_URL}/${transforms},f_auto,q_auto/${publicId}`;
}

# Blue River Gutters - Content Engine Setup Guide

## For Adam: Connecting Your Accounts

This guide walks you through connecting your Jobber and Google Business Profile accounts to the Content Engine so it can automatically create posts when you complete jobs.

---

## Prerequisites

Before starting, you'll need:
- Your Jobber login credentials
- Access to your Google account that manages Blue River Gutters' Google Business Profile
- About 10 minutes

---

## Step 1: Connect Jobber

### What This Does
Connects the Content Engine to your Jobber account so it can receive notifications when jobs are completed and access job details/photos.

### How to Connect

1. **Open the authorization link:**
   ```
   https://brg-content-engine.micaiah-tasks.workers.dev/auth/jobber
   ```

2. **Log in to Jobber** (if not already logged in)

3. **Click "Authorize"** when Jobber asks if you want to allow access

4. **You'll see a success page** - you can close it

### Verify Connection
Visit this URL to confirm it's connected:
```
https://brg-content-engine.micaiah-tasks.workers.dev/auth/status
```

You should see `"jobber": { "connected": true }`

---

## Step 2: Connect Google Business Profile

### What This Does
Allows the Content Engine to automatically post updates to your Google Business Profile when jobs are completed.

### How to Connect

1. **Open the authorization link:**
   ```
   https://brg-content-engine.micaiah-tasks.workers.dev/auth/google
   ```

2. **Sign in with the Google account** that manages your Blue River Gutters business profile

3. **Click "Allow"** when Google asks for permissions

4. **You'll see a success page** - you can close it

### Verify Connection
Visit this URL to confirm it's connected:
```
https://brg-content-engine.micaiah-tasks.workers.dev/auth/status
```

You should see `"google": { "connected": true }`

---

## Step 3: Test the System

### Option A: Wait for a Real Job
Next time you complete a job in Jobber and mark the visit as complete, the system will automatically:
1. Pull the job details
2. Upload photos to Cloudinary
3. Create a Google Business Profile post
4. Add the project to your website

### Option B: Trigger a Test
Ask your web team to send a test webhook to verify everything is working.

---

## What Happens Automatically

Once connected, here's what happens when you complete a job:

1. **Jobber sends a notification** to the Content Engine
2. **Job details are pulled** - service type, location, photos
3. **Photos are uploaded** to your CDN for fast loading
4. **A GBP post is created** with the job photo and a "Book Now" button
5. **A project page is added** to your website's Recent Projects section

All of this happens within about 30 seconds of marking a visit complete.

---

## Troubleshooting

### "Not connected" error
- Try the authorization link again
- Make sure you're logged into the correct account (Jobber or Google)
- If it still fails, contact your web team

### Posts not appearing on GBP
- It can take a few minutes for Google to show new posts
- Check the Content Engine status page to verify the post was created

### Photos not showing
- Make sure photos are attached to the job in Jobber before completing
- Photos need to be attached to the job, not just the client record

---

## Need Help?

Contact Untitled Publishers:
- Email: [your support email]
- The system logs all activity, so we can diagnose any issues

---

## Security Notes

- Your login credentials are never stored by the Content Engine
- We only store access tokens that can be revoked at any time
- You can disconnect at any time by revoking access in Jobber Settings or Google Account settings

---

*Last Updated: February 2026*
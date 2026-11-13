# Deploy Subversive Radio — Get Your Permanent Broadcast URL

## Option 1: Render.com (Recommended — Free)

1. Go to https://render.com and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub repo OR use **Public Git Repository**
4. Settings:
   - **Name**: `subversive-radio` (or your station name)
   - **Runtime**: Node
   - **Build Command**: `npm install --production`
   - **Start Command**: `node server.js`
5. Click **Create Web Service**
6. Your permanent URL: `https://subversive-radio.onrender.com`

Listener page: `https://subversive-radio.onrender.com`
Broadcaster:   `https://subversive-radio.onrender.com/broadcaster`

## Option 2: Railway.app (Free tier)

1. Go to https://railway.app and sign up
2. Click **New Project** → **Deploy from GitHub**
3. Select your repo
4. It auto-detects Node.js and deploys
5. Your URL: `https://subversive-radio.up.railway.app`

## Option 3: Fly.io (Free tier)

1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. Run: `fly auth signup`
3. Run: `fly launch`
4. Run: `fly deploy`
5. Your URL: `https://subversive-radio.fly.dev`

## Push to GitHub First

```bash
cd subversive-radio
git remote add origin https://github.com/YOUR_USERNAME/subversive-radio.git
git push -u origin main
```

Then connect the repo to your hosting platform.

## AutoDJ music library on Cloudflare R2

The AutoDJ (`/schedule`) keeps uploaded music and the schedule in a Cloudflare R2 bucket,
so nothing is lost when Render restarts or redeploys. After a restart the server loads the
schedule from R2 and downloads the tracks again before playing them.

1. Cloudflare dashboard > R2 Object Storage > Create bucket, e.g. `subversive-autodj` (keep it private).
2. R2 > Manage API tokens > Create API token, permission **Object Read & Write**, limited to that bucket.
   Copy the Access Key ID and Secret Access Key (the secret is only shown once).
3. Your Account ID is shown on the R2 overview page.
4. Render > subversive-radio > Environment, add:
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
5. Save, let Render redeploy, then open `/schedule`. The library header should read `R2 · ...`.

Without these variables the library is stored on the server disk only (fine for local use).
Free tier: 10 GB storage, which is roughly 170 hours of music at 128 kbps.

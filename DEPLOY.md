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

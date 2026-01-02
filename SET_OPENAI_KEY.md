# Setting OpenAI API Key in Vercel

## ⚠️ Important: Never commit API keys to git!

API keys must be set as environment variables in Vercel Dashboard, NOT in code files.

## Steps to Set Your OpenAI API Key in Vercel

### Option 1: Vercel Dashboard (Recommended)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project (e.g., `trace-web` or your project name)
3. Go to **Settings** → **Environment Variables**
4. Add a new environment variable:
   - **Key:** `OPENAI_API_KEY`
   - **Value:** `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`
   - **Environment:** Select all (Production, Preview, Development) or just Production
5. Click **Save**
6. **Redeploy** your project:
   - Go to **Deployments** tab
   - Click the three dots (⋯) on the latest deployment
   - Click **Redeploy**

### Option 2: Vercel CLI

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Set the environment variable for production
vercel env add OPENAI_API_KEY production

# When prompted, paste your key:
# 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

# Redeploy
vercel --prod
```

## Verify the Key is Set

After deployment, test the endpoint:

```bash
curl -X POST https://your-domain.vercel.app/api/vision \
  -H "Content-Type: application/json" \
  -d '{"photos": [{"filename": "test.jpg", "data": "test"}]}'
```

You should get a response (even if it's an error about the image data, not about missing API key).

## Security Best Practices

✅ **DO:**
- Set keys in Vercel Dashboard environment variables
- Use different keys for different environments if needed
- Rotate keys periodically
- Use service account keys (which you are - good!)

❌ **DON'T:**
- Commit API keys to git
- Hardcode keys in source code
- Share keys in public channels
- Store keys in client-side code

## Your Key

Your new OpenAI API key (service account):
```
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
```

**Copy this key and paste it into Vercel Dashboard → Environment Variables → OPENAI_API_KEY**

---

**After setting the key in Vercel, your functions will automatically use it. No code changes needed!**


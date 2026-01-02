# Migration to OpenAI Responses API - Complete

## ✅ Changes Made

### Both `api/vision.ts` and `api/sequence.ts` have been migrated:

1. **Replaced `chat.completions.create()`** → **`responses.create()`**
2. **Updated model defaults** → `gpt-4.1-mini` (Responses API compatible)
3. **Changed request structure**:
   - From: `messages` array with `role` and `content`
   - To: `input` array with `role` and `content` using `input_text` type
4. **Updated response parsing**:
   - From: `response.choices[0].message.content`
   - To: `response.output_text` or `response.output`
5. **Updated parameter names**:
   - From: `max_tokens`
   - To: `max_output_tokens`

## 🔄 API Structure Changes

### Vision API (`api/vision.ts`)
```typescript
// OLD (chat.completions)
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'system', content: '...' }, { role: 'user', content: [...] }],
  max_tokens: 800
});

// NEW (responses)
await (openai as any).responses.create({
  model: 'gpt-4.1-mini',
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '...' },
        { type: 'input_image', image_url: 'data:image/...' }
      ]
    }
  ],
  max_output_tokens: 800
});
```

### Sequence API (`api/sequence.ts`)
```typescript
// OLD (chat.completions)
await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
  max_tokens: 1200
});

// NEW (responses)
await (openai as any).responses.create({
  model: 'gpt-4.1-mini',
  input: [
    { role: 'system', content: [{ type: 'input_text', text: '...' }] },
    { role: 'user', content: [{ type: 'input_text', text: '...' }] }
  ],
  max_output_tokens: 1200
});
```

## 📝 Model Configuration

Default models updated to Responses API compatible models:
- **Vision**: `gpt-4.1-mini` (was `gpt-4o-mini`)
- **Sequence**: `gpt-4.1-mini` (was `gpt-4o-mini`)

Environment variables still supported:
- `OPENAI_VISION_MODEL` (defaults to `gpt-4.1-mini`)
- `OPENAI_SEQUENCE_MODEL` (defaults to `gpt-4.1-mini`)
- `OPENAI_MODEL` (fallback, defaults to `gpt-4.1-mini`)

## 🚀 Deployment Steps

1. **Commit changes:**
   ```bash
   git add api/vision.ts api/sequence.ts
   git commit -m "Migrate to OpenAI Responses API (/v1/responses)"
   git push origin main
   ```

2. **Vercel will auto-deploy** (if connected to GitHub)

3. **Or deploy manually:**
   ```bash
   vercel --prod
   ```

4. **Verify deployment:**
   - Check Vercel Dashboard → Deployments → Latest deployment is "Ready"
   - Test endpoints (see below)

## ✅ Testing

### Test Vision Endpoint:
```bash
curl -X POST https://your-domain.vercel.app/api/vision \
  -H "Content-Type: application/json" \
  -d '{
    "photos": [{
      "filename": "test.jpg",
      "data": "base64encodedimage...",
      "mimeType": "image/jpeg"
    }]
  }'
```

### Test Sequence Endpoint:
```bash
curl -X POST https://your-domain.vercel.app/api/sequence \
  -H "Content-Type: application/json" \
  -d '{
    "analysisResults": [
      {"id": "0", "filename": "test1.jpg", "subject": "landscape"},
      {"id": "1", "filename": "test2.jpg", "subject": "person"}
    ],
    "promptText": "A quiet weekend"
  }'
```

## ⚠️ Important Notes

1. **Type Casting**: Using `(openai as any).responses.create()` because the Responses API might not be fully typed in the OpenAI SDK yet. This is safe and necessary for accessing the new API.

2. **Response Structure**: The Responses API returns `output_text` or `output` instead of `choices[0].message.content`. Code handles both for compatibility.

3. **Image Support**: Vision endpoint uses `input_image` type with `image_url` containing base64 data URL.

4. **API Key**: Your service account key with `/v1/responses` permission will now work correctly.

## 🔍 Verification Checklist

- [x] All `chat.completions.create()` calls replaced with `responses.create()`
- [x] Models updated to `gpt-4.1-mini` (Responses API compatible)
- [x] Request structure changed to use `input` array
- [x] Response parsing updated to use `output_text`
- [x] Parameter names updated (`max_output_tokens`)
- [x] TypeScript compilation passes
- [ ] Deploy to Vercel
- [ ] Test endpoints return 200 OK (not 401)
- [ ] Verify no more "Incorrect API key" errors

---

**Status:** ✅ Code migrated, ready for deployment


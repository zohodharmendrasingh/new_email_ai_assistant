'use strict';

// Fallback env vars — override via Catalyst console for production
process.env.ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || "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";
process.env.ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID     || "1000.6DD4QP4PCB7OKX7ERC4PAICZURLLKX";
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "b9aad1c99e593ec6a65def4f501f285c9f29a9a20f";
process.env.ZOHO_REDIRECT_URI  = process.env.ZOHO_REDIRECT_URI  || "https://emailassistantversiontwo-919781692.development.catalystserverless.com/server/email_assistantversiontwo_function/auth/zoho/callback";
process.env.APP_PASSWORD       = process.env.APP_PASSWORD       || "Metwall2024!";
process.env.ZOHO_ACCESS_TOKEN  = process.env.ZOHO_ACCESS_TOKEN  || "1000.7276a86a184e908177bc155050a10403.9a9affc301219838f9e41bbaf4165c5b";
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "1000.5d60100a8c9969b90610f969a95d4a30.aaf097583839022b1947f242d52b8b44";
process.env.ZOHO_ACCOUNT_ID   = process.env.ZOHO_ACCOUNT_ID   || "4862555000000008001";

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { writeFileSync, readFileSync, existsSync } = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SIG_PATH = '/tmp/signature.png';

const SYSTEM_PROMPT = `You are an email assistant for Alfonso Mendez, President & CEO of Metwall, a demountable wall manufacturer based in Houston, TX.

Given an email subject and body:
1. Detect the sender's language (English or Spanish)
2. Classify priority: "urgent", "follow-up", or "low-priority"
3. Write a professional draft reply that:
   - Uses the ACTUAL sender's name from the email if found, otherwise use "Estimado/a" or "Dear"
   - Is relevant to the ACTUAL content of the email
   - Is signed as "Alfonso Mendez" - NEVER use [Su nombre] or placeholders
   - Matches the sender's language

CRITICAL: Never use placeholder text like [Su nombre], [nombre], María, or any fake names.
Always sign as: Alfonso Mendez | President & CEO | Metwall

Respond ONLY with valid JSON, no code blocks:
{
  "language": "English" | "Spanish",
  "priority": "urgent" | "follow-up" | "low-priority",
  "reason": "<one sentence>",
  "draft_reply": "<full reply signed as Alfonso Mendez>"
}`;

app.post('/triage', async (req, res) => {
  const { subject, body, from: sender, personality } = req.body;
  const autoSenders = ['noreply','no-reply','notification','notifications','mailer','alerts','newsletter','marketing','feedback@service','zoho-','donotreply','auto-confirm'];
  const isAuto = autoSenders.some(k => (sender || '').toLowerCase().includes(k));
  if (isAuto) return res.json({ no_reply: 'This is an automated email — no reply needed.', priority: 'no-reply', draft_reply: '' });

  if (!subject || !body) {
    return res.status(400).json({ error: "Both 'subject' and 'body' fields are required." });
  }

  try {
    const userMessage = `Subject: ${subject}\n\nBody:\n${body}`;
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: personality ? personality + '\n\n' + SYSTEM_PROMPT : SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'No text response from Claude.' });

    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const triage = JSON.parse(cleaned);
    const htmlReply = '<div>' + triage.draft_reply.replace(/\n/g, '<br>') + '<br><br><hr><strong>Alfonso Mendez</strong><br>President & CEO | Metwall<br>M (281) 827 3470 | D (346) 406 1330<br>www.metwall.com</div>';
    res.json({ draft_reply: htmlReply });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Zoho OAuth flow ---

app.get('/auth/zoho', (_req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoMail.messages.All,ZohoMail.accounts.All,ZohoMail.folders.READ',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: 'offline',
  });
  res.redirect(`https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`);
});

app.get('/auth/zoho/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri: process.env.ZOHO_REDIRECT_URI,
    });
    const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(`Token error: ${tokenData.error}`);

    const { access_token, refresh_token } = tokenData;
    const accountRes = await fetch('https://mail.zoho.com/api/accounts', {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
    });
    if (!accountRes.ok) throw new Error(`Account fetch failed: ${accountRes.status}`);
    const accountData = await accountRes.json();
    const accountId = accountData.data?.[0]?.accountId ?? '';

    const redirectParams = new URLSearchParams({ access_token, refresh_token, account_id: accountId });
    res.redirect(`/?${redirectParams.toString()}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(error.message);
  }
});

// --- Zoho Mail helpers ---

let zohoAccessToken = process.env.ZOHO_ACCESS_TOKEN;

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function getAccountId(req) {
  return req.headers['x-account-id'] || process.env.ZOHO_ACCOUNT_ID;
}

async function refreshZohoToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
  });
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh error: ${data.error}`);
  zohoAccessToken = data.access_token;
}

async function zohoFetch(url, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${activeToken}` } });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoFetch(url, null, true);
  }
  if (!res.ok) throw new Error(`Zoho API error ${res.status}: ${url}`);
  return res.json();
}

async function zohoDelete(url, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${activeToken}` } });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoDelete(url, null, true);
  }
  if (!res.ok) throw new Error(`Zoho API error ${res.status}: ${url}`);
  return res.json();
}

async function zohoPut(url, payload, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Zoho-oauthtoken ${activeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoPut(url, payload, null, true);
  }
  if (!res.ok) throw new Error(`Zoho API error ${res.status}: ${url}`);
  return res.json();
}

async function zohoPost(url, payload, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${activeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoPost(url, payload, null, true);
  }
  if (!res.ok) {
    const errorBody = await res.text();
    console.error('Zoho error body:', errorBody);
    console.error('Request sent:', JSON.stringify(payload));
    throw new Error(`Zoho API error ${res.status}: ${url}`);
  }
  return res.json();
}

app.post('/rsvp', async (req, res) => {
  const { rsvpUrl } = req.body;
  if (!rsvpUrl) return res.status(400).json({ error: 'Missing rsvpUrl' });
  try {
    await refreshZohoToken();
    const r = await fetch(rsvpUrl, { headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` } });
    if (r.ok) return res.json({ ok: true });
    const r2 = await fetch(rsvpUrl);
    return res.json({ ok: r2.ok, status: r2.status });
  } catch (err) {
    console.error('RSVP error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/inbox', async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) return res.status(500).json({ error: 'ZOHO_ACCOUNT_ID not set' });

  try {
    const listData = await zohoFetch(
      `https://mail.zoho.com/api/accounts/${accountId}/messages/view?limit=200&sortorder=false`,
      token
    );
    const messages = listData.data ?? [];
    const emails = messages.map(msg => ({
      id: msg.messageId,
      subject: msg.subject ?? '',
      from: msg.fromAddress ?? '',
      sender: msg.sender ?? msg.fromAddress ?? '',
      summary: msg.summary ?? '',
      receivedTime: msg.receivedTime ?? null,
      folderId: msg.folderId,
      messageId: msg.messageId,
      toAddress: msg.toAddress ?? '',
      ccAddress: msg.ccAddress ?? '',
      status: msg.status ?? '',
    }));
    res.json(emails);
  } catch (error) {
    console.error('Error fetching inbox:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/create-draft', async (req, res) => {
  const { fromAddress, toAddress, subject, content } = req.body;
  const token = getBearerToken(req);
  const accountId = getAccountId(req);

  if (!fromAddress || !toAddress || !subject || !content) {
    return res.status(400).json({ error: "Fields 'fromAddress', 'toAddress', 'subject', and 'content' are required." });
  }
  if (!accountId) return res.status(500).json({ error: 'ZOHO_ACCOUNT_ID not set' });

  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      { fromAddress, toAddress, subject, content, mailFormat: 'html', mode: 'draft' },
      token
    );
    const draftId = data?.data?.messageId ?? data?.data?.id ?? null;
    res.json({ success: true, draftId });
  } catch (error) {
    console.error('Error creating draft:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/message/:folderId/:messageId', async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) return res.status(500).json({ error: 'ZOHO_ACCOUNT_ID not set' });

  const { folderId, messageId } = req.params;
  try {
    const detail = await zohoFetch(
      `https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
      token
    );
    const html = detail.data?.content ?? '';
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<img[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hasAttachments = detail.data?.hasAttachment ?? false;
    res.json({ id: messageId, html, text, hasAttachments });
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/contacts', async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) return res.status(500).json({ error: 'ZOHO_ACCOUNT_ID not set' });

  try {
    const data = await zohoFetch(`https://mail.zoho.com/api/accounts/${accountId}/contacts`, token);
    const contacts = (data.data ?? []).map(c => ({
      name: c.fullName ?? c.firstName ?? '',
      email: c.email ?? '',
      company: c.company ?? '',
    }));
    res.json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.APP_PASSWORD) {
    return res.json({ token: 'valid' });
  }
  return res.status(401).json({ error: 'wrong' });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/debug/folders', async (req, res) => {
  try {
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` },
    });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/message/:folderId/:messageId/spam', async (req, res) => {
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  const { folderId, messageId } = req.params;
  try {
    const r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!r.ok) throw new Error('Zoho ' + r.status);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/agent', async (req, res) => {
  const { message, emails, lanes } = req.body;
  try {
    const list = (emails || []).slice(0, 50).map(e => `ID:${e.id} From:${e.from} Subject:${e.subject} Lane:${e.lane}`).join('\n');
    const ls = (lanes || []).map(l => `${l.id}:${l.label}`).join(', ');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: `Email assistant for Alfonso at Metwall. Lanes: ${ls}\nEmails:\n${list}\nInstruction: "${message}"\nReply ONLY with valid JSON no markdown: {"actions":[{"type":"move","emailId":"...","toLane":"..."}],"message":"brief confirmation"}` }] }),
    });
    const d = await r.json();
    const txt = (d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    res.json(JSON.parse(txt));
  } catch (e) {
    res.status(500).json({ error: e.message, message: 'Agent error: ' + e.message, actions: [] });
  }
});

app.post('/refine-draft', async (req, res) => {
  const { instruction, currentDraft, subject, from } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: `You are refining an email draft for Alfonso Mendez, President & CEO at Metwall.\nEmail context: Replying to "${from}" about "${subject}"\nCurrent draft:\n${currentDraft}\n\nUser instruction: "${instruction}"\n\nRewrite the draft following the instruction. Keep Alfonso's signature style: professional, concise, warm. This is a ONE-TIME refinement for THIS specific email only — do not generalize. Apply the instruction precisely to this email.\nReply ONLY with valid JSON: {"draft":"the refined draft text here","message":"brief note about what you changed"}` }] }),
    });
    const d = await r.json();
    const txt = (d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    res.json(JSON.parse(txt));
  } catch (e) {
    res.status(500).json({ error: e.message, message: 'Failed: ' + e.message });
  }
});

app.post('/reply', async (req, res) => {
  const { fromAddress, toAddress, subject, content, messageId } = req.body;
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      { fromAddress, toAddress, subject, content, mailFormat: 'html', mode: 'sendmail', inReplyTo: messageId },
      token
    );
    res.json({ success: true, messageId: data?.data?.messageId });
  } catch (e) {
    console.error('Reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/forward', async (req, res) => {
  const { fromAddress, toAddress, subject, content } = req.body;
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      { fromAddress, toAddress, subject, content, mailFormat: 'html', mode: 'sendmail' },
      token
    );
    res.json({ success: true, messageId: data?.data?.messageId });
  } catch (e) {
    console.error('Forward error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/drafts', async (req, res) => {
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages/view?folderId=4862555000000008015&limit=50&sortorder=false`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const d = await r.json();
    const raw = Array.isArray(d.data) ? d.data : (d.data ? [d.data] : []);
    const msgs = raw.map(m => ({
      id: m.messageId,
      subject: m.subject || '(no subject)',
      to: m.toAddress || m.toAddr || '',
      time: m.sentDateInGMT || m.receivedTime,
      summary: m.summary || '',
      folderId: '4862555000000008015',
    }));
    res.json(msgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Signature — stored in /tmp (ephemeral but re-uploaded from localStorage on each page load)
app.post('/signature', (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image' });
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    writeFileSync(SIG_PATH, Buffer.from(base64, 'base64'));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/signature.png', (req, res) => {
  try {
    if (!existsSync(SIG_PATH)) return res.status(404).send('Not found');
    const img = readFileSync(SIG_PATH);
    res.set('Content-Type', 'image/png');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(img);
  } catch (e) {
    res.status(500).send('Error');
  }
});

app.post('/mark-read', async (req, res) => {
  const { folderId, messageId, isRead } = req.body;
  if (!folderId || !messageId) return res.status(400).json({ error: 'Missing fields' });
  try {
    let token = getBearerToken(req) || zohoAccessToken;
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const url = `https://mail.zoho.com/api/accounts/${accountId}/updatemessage`;
    const payload = { mode: isRead ? 'markAsRead' : 'markAsUnread', messageId: [messageId], folderId };
    const response = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      await refreshZohoToken();
      token = zohoAccessToken;
      const retry = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const retryData = await retry.json();
      return res.json({ success: true, data: retryData });
    }
    const zohoData = await response.json();
    res.json({ success: true, data: zohoData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let _folderCache = null;

async function getFolders(token, accountId) {
  if (_folderCache) return _folderCache;
  let r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (r.status === 401) {
    await refreshZohoToken();
    r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` },
    });
  }
  const d = await r.json();
  if (!d.data || d.status?.code === 401) throw new Error('Could not fetch folders: ' + JSON.stringify(d));
  _folderCache = d.data;
  return _folderCache;
}

app.delete('/message/:folderId/:messageId', async (req, res) => {
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  const { folderId, messageId } = req.params;
  try {
    const response = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!response.ok) throw new Error(`Zoho error ${response.status}: ${await response.text()}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error trashing message:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

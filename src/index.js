import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

app.post("/triage", async (req, res) => {
  const { subject, body, from: sender, personality } = req.body;
  // Detect automated emails
  const autoSenders = ["noreply","no-reply","notification","notifications","mailer","alerts","newsletter","marketing","feedback@service","zoho-","donotreply","auto-confirm"];
  const isAuto = autoSenders.some(k => (sender||"").toLowerCase().includes(k));
  if (isAuto) return res.json({ no_reply: "This is an automated email — no reply needed.", priority: "no-reply", draft_reply: "" });

  if (!subject || !body) {
    return res.status(400).json({ error: "Both 'subject' and 'body' fields are required." });
  }

  try {
    const userMessage = `Subject: ${subject}\n\nBody:\n${body}`;

    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: personality ? personality + "\n\n" + SYSTEM_PROMPT : SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(500).json({ error: "No text response from Claude." });
    }

    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const triage = JSON.parse(cleaned);
    const htmlReply = "<div>" + triage.draft_reply.replace(/\n/g, "<br>") + "<br><br><hr><strong>Alfonso Mendez</strong><br>President & CEO | Metwall<br>M (281) 827 3470 | D (346) 406 1330<br>www.metwall.com</div>";

    res.json({ draft_reply: htmlReply });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Zoho OAuth flow ---

app.get("/auth/zoho", (_req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: "ZohoMail.messages.All,ZohoMail.accounts.All,ZohoMail.folders.READ",
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: "offline",
  });
  res.redirect(`https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`);
});

app.get("/auth/zoho/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri: process.env.ZOHO_REDIRECT_URI,
    });
    const tokenRes = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(`Token error: ${tokenData.error}`);

    const { access_token, refresh_token } = tokenData;

    const accountRes = await fetch("https://mail.zoho.com/api/accounts", {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
    });
    if (!accountRes.ok) throw new Error(`Account fetch failed: ${accountRes.status}`);
    const accountData = await accountRes.json();
    const accountId = accountData.data?.[0]?.accountId ?? "";

    const redirectParams = new URLSearchParams({ access_token, refresh_token, account_id: accountId });
    res.redirect(`/?${redirectParams.toString()}`);
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).send(error.message);
  }
});

// --- Zoho Mail helpers ---

let zohoAccessToken = process.env.ZOHO_ACCESS_TOKEN;

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function getAccountId(req) {
  return req.headers["x-account-id"] || process.env.ZOHO_ACCOUNT_ID;
}

async function refreshZohoToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh error: ${data.error}`);
  zohoAccessToken = data.access_token;
}

async function zohoFetch(url, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${activeToken}` },
  });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoFetch(url, null, true);
  }
  if (!res.ok) throw new Error(`Zoho API error ${res.status}: ${url}`);
  return res.json();
}

async function zohoDelete(url, token, retried = false) {
  const activeToken = token ?? zohoAccessToken;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Zoho-oauthtoken ${activeToken}` },
  });
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
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${activeToken}`,
      "Content-Type": "application/json",
    },
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
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${activeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 && !retried && !token) {
    await refreshZohoToken();
    return zohoPost(url, payload, null, true);
  }
  if (!res.ok) {
    const errorBody = await res.text();
    console.error("Zoho error body:", errorBody);
    console.error("Request sent:", JSON.stringify(payload));
    throw new Error(`Zoho API error ${res.status}: ${url}`);
  }
  return res.json();
}

app.get("/inbox", async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) {
    return res.status(500).json({ error: "ZOHO_ACCOUNT_ID not set" });
  }

  try {
    const listData = await zohoFetch(
      `https://mail.zoho.com/api/accounts/${accountId}/messages/view?limit=200&sortorder=false`,
      token
    );

    const messages = listData.data ?? [];

    const emails = messages.map((msg) => ({
      id: msg.messageId,
      subject: msg.subject ?? "",
      from: msg.fromAddress ?? "",
      sender: msg.sender ?? msg.fromAddress ?? "",
      summary: msg.summary ?? "",
      receivedTime: msg.receivedTime ?? null,
      folderId: msg.folderId,
      messageId: msg.messageId,
      toAddress: msg.toAddress ?? "",
      ccAddress: msg.ccAddress ?? "",
      status: msg.status ?? "",
    }));

    res.json(emails);
  } catch (error) {
    console.error("Error fetching inbox:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-draft", async (req, res) => {
  const { fromAddress, toAddress, subject, content } = req.body;
  const token = getBearerToken(req);
  const accountId = getAccountId(req);

  if (!fromAddress || !toAddress || !subject || !content) {
    return res.status(400).json({ error: "Fields 'fromAddress', 'toAddress', 'subject', and 'content' are required." });
  }
  if (!accountId) {
    return res.status(500).json({ error: "ZOHO_ACCOUNT_ID not set" });
  }

  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      {
        fromAddress,
        toAddress,
        subject,
        content,
        mailFormat: "html",
        mode: "draft",
      },
      token
    );
    const draftId = data?.data?.messageId ?? data?.data?.id ?? null;
    res.json({ success: true, draftId });
  } catch (error) {
    console.error("Error creating draft:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/message/:folderId/:messageId", async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) {
    return res.status(500).json({ error: "ZOHO_ACCOUNT_ID not set" });
  }

  const { folderId, messageId } = req.params;

  try {
    const detail = await zohoFetch(
      `https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
      token
    );
    const html = detail.data?.content ?? "";
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<img[^>]*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const hasAttachments = detail.data?.hasAttachment ?? false;
    res.json({ id: messageId, html, text, hasAttachments });
  } catch (error) {
    console.error("Error fetching message:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/contacts", async (req, res) => {
  const token = getBearerToken(req);
  const accountId = getAccountId(req);
  if (!accountId) {
    return res.status(500).json({ error: "ZOHO_ACCOUNT_ID not set" });
  }

  try {
    const data = await zohoFetch(
      `https://mail.zoho.com/api/accounts/${accountId}/contacts`,
      token
    );

    const contacts = (data.data ?? []).map((c) => ({
      name: c.fullName ?? c.firstName ?? "",
      email: c.email ?? "",
      company: c.company ?? "",
    }));

    res.json(contacts);
  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ error: error.message });
  }
});



app.post("/auth", (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.APP_PASSWORD) {
    return res.json({ token: "valid" });
  }
  return res.status(401).json({ error: "wrong" });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.get("/debug/folders", async (req, res) => {
  try {
    const token = zohoAccessToken;
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.post("/message/:folderId/:messageId/spam", async (req, res) => { const token = getBearerToken(req) || zohoAccessToken; const accountId = process.env.ZOHO_ACCOUNT_ID; const { folderId, messageId } = req.params; try { const r = await fetch("https://mail.zoho.com/api/accounts/" + accountId + "/folders/" + folderId + "/messages/" + messageId, { method: "DELETE", headers: { Authorization: "Zoho-oauthtoken " + token } }); if (!r.ok) throw new Error("Zoho " + r.status); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post("/agent", async (req, res) => {
  const { message, emails, lanes } = req.body;
  try {
    const list = (emails||[]).slice(0,50).map(e => `ID:${e.id} From:${e.from} Subject:${e.subject} Lane:${e.lane}`).join("\n");
    const ls = (lanes||[]).map(l => `${l.id}:${l.label}`).join(", ");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:1024,messages:[{role:"user",content:`Email assistant for Alfonso at Metwall. Lanes: ${ls}\nEmails:\n${list}\nInstruction: "${message}"\nReply ONLY with valid JSON no markdown: {"actions":[{"type":"move","emailId":"...","toLane":"..."}],"message":"brief confirmation"}`}]})
    });
    const d = await r.json();
    const txt = (d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim();
    res.json(JSON.parse(txt));
  } catch(e) { res.status(500).json({error:e.message,message:"Agent error: "+e.message,actions:[]}); }
});

app.post("/refine-draft", async (req, res) => {
  const { instruction, currentDraft, subject, from } = req.body;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:1024,messages:[{role:"user",content:`You are refining an email draft for Alfonso Mendez, President & CEO at Metwall.
Email context: Replying to "${from}" about "${subject}"
Current draft:
${currentDraft}

User instruction: "${instruction}"

Rewrite the draft following the instruction. Keep Alfonso's signature style: professional, concise, warm. Note any tone preferences mentioned for future reference. This is a ONE-TIME refinement for THIS specific email only — do not generalize. Apply the instruction precisely to this email. Note any tone preferences mentioned for future reference. This is a ONE-TIME refinement for THIS specific email only — do not generalize. Apply the instruction precisely to this email.
Reply ONLY with valid JSON: {"draft":"the refined draft text here","message":"brief note about what you changed"}`}]})
    });
    const d = await r.json();
    const txt = (d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim();
    res.json(JSON.parse(txt));
  } catch(e) { res.status(500).json({error:e.message,message:"Failed: "+e.message}); }
});

app.post("/reply", async (req, res) => {
  const { fromAddress, toAddress, subject, content, messageId, folderId } = req.body;
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      { fromAddress, toAddress, subject, content, mailFormat: "html", mode: "sendmail", inReplyTo: messageId },
      token
    );
    res.json({ success: true, messageId: data?.data?.messageId });
  } catch(e) {
    console.error("Reply error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/forward", async (req, res) => {
  const { fromAddress, toAddress, subject, content, messageId, folderId } = req.body;
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const data = await zohoPost(
      `https://mail.zoho.com/api/accounts/${accountId}/messages`,
      { fromAddress, toAddress, subject, content, mailFormat: "html", mode: "sendmail" },
      token
    );
    res.json({ success: true, messageId: data?.data?.messageId });
  } catch(e) {
    console.error("Forward error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/drafts", async (req, res) => {
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  try {
    const r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages/view?folderId=4862555000000008015&limit=50&sortorder=false`, {
      headers: { Authorization: "Zoho-oauthtoken " + token }
    });
    const d = await r.json();
    const raw = Array.isArray(d.data) ? d.data : (d.data ? [d.data] : []);
    const msgs = raw.map(m => ({
      id: m.messageId, subject: m.subject || "(no subject)", to: m.toAddress || m.toAddr || "",
      time: m.sentDateInGMT || m.receivedTime, summary: m.summary || "", folderId: "4862555000000008015"
    }));
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Email triage webhook running on http://localhost:${PORT}`);
  console.log(`POST /triage  { subject, body }`);
});


// Mark email as read/unread in Zoho Mail
app.post("/mark-read", async (req, res) => {
  const { folderId, messageId, isRead } = req.body;
  if (!folderId || !messageId) return res.status(400).json({ error: "Missing fields" });
  try {
    const token = getBearerToken(req) || zohoAccessToken;
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const url = "https://mail.zoho.com/api/accounts/" + accountId + "/updatemessage";
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": "Zoho-oauthtoken " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: isRead ? "markAsRead" : "markAsUnread",
        messageId: [messageId],
        folderId: folderId
      })
    });
    if (response.status === 401) {
      await refreshZohoToken();
      token = zohoAccessToken;
      const retry = await fetch(url, {
        method: "PUT",
        headers: { "Authorization": "Zoho-oauthtoken " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: isRead ? "markAsRead" : "markAsUnread", messageId: [messageId] })
      });
      const retryData = await retry.json();
      console.log("mark-read retry:", JSON.stringify(retryData));
      return res.json({ success: true, data: retryData });
    }
    const zohoData = await response.json();
    console.log("mark-read zoho response:", JSON.stringify(zohoData));
    res.json({ success: true, data: zohoData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache folder list to find trash/spam IDs
let _folderCache = null;
async function getFolders(token, accountId) {
  if (_folderCache) return _folderCache;
  let r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  if (r.status === 401) {
    await refreshZohoToken();
    r = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${zohoAccessToken}` }
    });
  }
  const d = await r.json();
  if (!d.data || d.status?.code === 401) throw new Error('Could not fetch folders: ' + JSON.stringify(d));
  _folderCache = d.data;
  return _folderCache;
}
async function getFolderIdByName(token, accountId, name) {
  const folders = await getFolders(token, accountId);
  const f = folders.find(f => (f.folderName||'').toLowerCase() === name.toLowerCase() || (f.folderType||'').toLowerCase() === name.toLowerCase());
  return f ? f.folderId : null;
}

app.delete("/message/:folderId/:messageId", async (req, res) => {
  const token = getBearerToken(req) || zohoAccessToken;
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  const { folderId, messageId } = req.params;
  try {
    const response = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}`, {
      method: "DELETE",
      headers: { "Authorization": "Zoho-oauthtoken " + token }
    });
    if (!response.ok) throw new Error(`Zoho error ${response.status}: ${await response.text()}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error trashing message:", error);
    res.status(500).json({ error: error.message });
  }
});

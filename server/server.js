// Gentle Giant council server.
// The game sends the village's state; this server builds the prompt itself, asks Claude
// for tonight's plans (/council) or for the villagers' spoken answers (/talk), checks them,
// and sends them back. The API key never leaves here.
const http = require('http');

const PORT = Number(process.env.PORT || 10000);
const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const WORKSPACE = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();   // only needed for keys not tied to one workspace
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const DAILY_CAP_USD = Number(process.env.DAILY_CAP_USD || 1);
// Claude Haiku 5.5 list prices per million tokens (prompts under 100K tokens)
const PRICE_IN = Number(process.env.PRICE_IN_PER_M || 0.10);
const PRICE_OUT = Number(process.env.PRICE_OUT_PER_M || 0.50);
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://ostromaj.github.io').split(',').map(s => s.trim()).filter(Boolean);
const PER_PLAYER_PER_HOUR = Number(process.env.PER_PLAYER_PER_HOUR || 20);
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 40);
const MAX_OUTPUT_TOKENS = 700;
const TALK_PER_PLAYER_PER_HOUR = Number(process.env.TALK_PER_PLAYER_PER_HOUR || 40);
const TALK_PER_IP_PER_HOUR = Number(process.env.TALK_PER_IP_PER_HOUR || 80);
// talking may use at most this share of the daily cap, so the nightly council always has budget left
const TALK_SHARE = Number(process.env.TALK_SHARE || 0.6);

const PLAN_TYPES = ['festival', 'gift', 'petition', 'ambush', 'lure', 'exodus', 'watch', 'hide_children'];
const PLACES = ['river', 'fields', 'homes'];
const REQUESTS = ['water', 'rebuild', 'food', 'not_step'];
// the villagers' whole spoken language: these glyphs and nothing else
const VOCAB = ['sun', 'water', 'home', 'child', 'food', 'step', 'big', 'good', 'not', 'hide', 'sing', 'go', 'please', 'afraid', 'fight', 'fire', 'stone', 'dead', 'name'];
const ACTS = ['none', 'approach', 'flee', 'hide', 'gift', 'sing'];

let spendDay = utcDay(), spent = 0, talkSpent = 0, calls = 0, lastError = null;
const hits = new Map();   // key -> [timestamps]

function utcDay() { return new Date().toISOString().slice(0, 10); }
function rollDay() { const d = utcDay(); if (d !== spendDay) { spendDay = d; spent = 0; talkSpent = 0; calls = 0; } }
function allow(key, limit) {
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < 3600e3);
  if (list.length >= limit) { hits.set(key, list); return false; }
  list.push(now); hits.set(key, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) { const keep = l.filter(t => now - t < 3600e3); if (keep.length) hits.set(k, keep); else hits.delete(k); } }, 600e3).unref();

const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);

// only structured game data gets through; nothing the client sends becomes an instruction
function cleanPayload(p) {
  const w = (p && p.world) || {};
  const world = {
    day: num(w.day, 1, 999), season: str(w.season, 12), weather: str(w.weather, 12), giantName: str(w.giantName, 12),
    revolt: str(w.revolt, 16), tyrantRule: !!w.tyrantRule, homesDestroyed: num(w.homesDestroyed, 0, 99),
    struckDownByLightning: arr(w.struckDownByLightning, 12).map(s => str(s, 16)), departed: arr(w.departed, 12).map(s => str(s, 16)),
    giantAspect: str(w.giantAspect, 12) || null, giantKindness: num(w.giantKindness, 0, 999), wordsTheGiantUnderstands: num(w.wordsTheGiantUnderstands, 0, 40),
    giantCanReadSecretScript: !!w.giantCanReadSecretScript, needs: arr(w.needs, 4).map(s => str(s, 48)), giantFavouritePlace: str(w.giantFavouritePlace, 32),
    pimHasGrownInto: str(w.pimHasGrownInto, 20), rumors: arr(w.rumors, 4).map(s => str(s, 100)), recentOutcomes: arr(w.recentOutcomes, 8).map(s => str(s, 160)),
  };
  const villagers = arr(p && p.villagers, 14).map(v => ({
    name: str(v.name, 16), role: str(v.role, 16), fear: num(v.fear, 0, 100), trust: num(v.trust, 0, 100), anger: num(v.anger, 0, 100),
    grief: v.grief ? str(v.grief, 16) : null, faction: v.faction === 'rebel' ? 'rebel' : 'loyal', memories: arr(v.memories, 5).map(s => str(s, 120)),
  })).filter(v => v.name);
  return { world, villagers };
}

function buildPrompt(d) {
  return `You are the collective mind of a tiny village in a video game called Gentle Giant. A giant (${d.world.giantName || 'the giant'}) lives in the valley. It thinks it is loved. The villagers are afraid of it, and some resent it. Tonight the adults meet in secret at the hall to decide what to do tomorrow.

Choose one or two plans the village will carry out, in character, based on how each villager feels and what they remember. The giant has been kind or cruel; let that show. Factions can disagree. A loyal villager who dislikes a harsh plan may secretly warn the giant (a "dissent").

Plan types (use exactly these):
- festival: dance and sing in the plaza to please the giant.
- gift: bring flowers to the giant's feet.
- petition: walk up and ask the giant for something. Needs "request": one of water, rebuild, food, not_step.
- ambush: hide at a place and attack with stones and ropes when the giant comes. Needs "place": one of river, fields, homes.
- lure: leave bait food with hidden stakes around it. Needs "place": one of river, fields, homes.
- exodus: some villagers sneak over the mountain pass tonight and leave forever.
- watch: post lookouts at night who warn everyone when the giant comes near.
- hide_children: keep the children indoors and away from the giant tomorrow.

Rules: members are 1 to 5 villager names from the list below, and the leader must be one of them. Pim may only join if Pim has grown up. Keep the goal to one short sentence in a villager's voice. Use a rumor only if something has happened that would start one (under 12 words). Keep everything suitable for a gentle fantasy game: no gore.

State of the valley:
${JSON.stringify(d.world)}

The villagers:
${JSON.stringify(d.villagers)}

Reply with only JSON in exactly this shape:
{"plans":[{"type":"ambush","place":"river","leader":"Kett","members":["Kett","Rook","Joss"],"goal":"We drive it out before it kills again."}],"dissent":{"name":"Nel","plan":0},"rumor":"The sky strikes whoever the giant looks at.","note":"one sentence about the mood of the council"}
"dissent" and "rumor" may be null.`;
}

function cleanReply(j, d) {
  const names = new Set(d.villagers.map(v => v.name));
  const plans = arr(j && j.plans, 2).filter(p => p && PLAN_TYPES.includes(p.type)).map(p => {
    const members = arr(p.members, 5).map(n => str(n, 16)).filter(n => names.has(n));
    const leader = names.has(str(p.leader, 16)) ? str(p.leader, 16) : members[0];
    return { type: p.type, place: PLACES.includes(p.place) ? p.place : undefined, request: REQUESTS.includes(p.request) ? p.request : undefined, leader, members: [...new Set([leader, ...members])].filter(Boolean).slice(0, 5), goal: str(p.goal, 140) };
  }).filter(p => p.leader);
  const ds = j && j.dissent && names.has(str(j.dissent.name, 16)) ? { name: str(j.dissent.name, 16), plan: num(j.dissent.plan, 0, 1) } : null;
  return { plans, dissent: ds, rumor: j && j.rumor ? str(j.rumor, 100) : null, note: j && j.note ? str(j.note, 160) : '' };
}

function parseJSON(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch (e) { }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch (e) { } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { } }
  return null;
}

async function askClaude(prompt, maxTokens, isTalk) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: Object.assign({ authorization: 'Bearer ' + KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, WORKSPACE ? { 'anthropic-workspace-id': WORKSPACE } : {}),
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.usage) { const c = (j.usage.input_tokens || 0) / 1e6 * PRICE_IN + (j.usage.output_tokens || 0) / 1e6 * PRICE_OUT; spent += c; if (isTalk) talkSpent += c; calls++; }
  if (!r.ok) {
    console.error('claude error', r.status, JSON.stringify(j).slice(0, 300));
    lastError = { at: new Date().toISOString(), status: r.status, type: (j.error && j.error.type) || '', message: String((j.error && j.error.message) || '').slice(0, 200) };
    return null;
  }
  lastError = null;
  return parseJSON((j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''));
}
function ready() {
  rollDay();
  if (!KEY) return [503, { error: 'the server has no API key yet' }];
  if (spent >= DAILY_CAP_USD) return [429, { error: 'daily budget reached' }];
  return null;
}

async function council(body) {
  const no = ready(); if (no) return no;
  const d = cleanPayload(body && body.payload);
  if (!d.villagers.length) return [400, { error: 'no villagers' }];
  const parsed = await askClaude(buildPrompt(d), MAX_OUTPUT_TOKENS);
  if (!parsed) return [502, { error: 'Claude could not answer right now' }];
  return [200, cleanReply(parsed, d)];
}

// ---------- talking: the giant says a few glyphs, villagers answer in glyphs ----------
function cleanPerson(v) {
  return {
    name: str(v && v.name, 16), role: str(v && v.role, 16), child: !!(v && v.child), fear: num(v && v.fear, 0, 100), trust: num(v && v.trust, 0, 100), anger: num(v && v.anger, 0, 100),
    grief: v && v.grief ? str(v.grief, 16) : null, faction: v && v.faction === 'rebel' ? 'rebel' : 'loyal', doing: str(v && v.doing, 60),
    memories: arr(v && v.memories, 3).map(s => str(s, 100)), talkedWithGiant: arr(v && v.talk, 3).map(s => str(s, 120)),
  };
}
function cleanTalk(p) {
  const w = (p && p.world) || {};
  return {
    kind: p && p.kind === 'hail' ? 'hail' : 'reply',
    said: arr(p && p.said, 4).map(x => str(x, 8)).filter(x => VOCAB.includes(x)),
    effect: str(p && p.effect, 160),
    world: {
      day: num(w.day, 1, 999), time: str(w.time, 12), season: str(w.season, 12), weather: str(w.weather, 12), giantName: str(w.giantName, 12),
      giantKneeling: !!w.giantKneeling, revolt: str(w.revolt, 16), tyrantRule: !!w.tyrantRule, homesDestroyed: num(w.homesDestroyed, 0, 99),
      struckDownByLightning: arr(w.struckDownByLightning, 12).map(s => str(s, 16)), giantAspect: str(w.giantAspect, 12) || null,
      wordsTheGiantUnderstands: arr(w.known, 19).map(x => str(x, 8)).filter(x => VOCAB.includes(x)), recentEvents: arr(w.recent, 3).map(s => str(s, 120)),
    },
    speakers: arr(p && p.speakers, 3).map(cleanPerson).filter(v => v.name),
    overhearers: arr(p && p.overhearers, 2).map(cleanPerson).filter(v => v.name),
  };
}
const GLOSS = 'sun, water, home, child, food, step, big, good, not (also means "no"), hide, sing, go, please, afraid, fight, fire, stone, dead, name (the village\'s name for the giant)';
function talkPrompt(d) {
  const said = d.said.map(x => x === 'name' ? '[their name for the giant]' : x === 'not' ? 'no/not' : x).join(' ');
  const opening = d.kind === 'hail'
    ? `The giant is kneeling nearby, quiet. The first villager listed under "Speakers" works up the nerve to say something to it unprompted: a question, a request, a fear, thanks, or a warning, depending on how they feel.`
    : `The giant just spoke to them in their own glyphs, ${d.world.giantKneeling ? 'softly, kneeling' : 'in a booming voice that shook the ground'}: "${said}". What the game decided happens because of it: ${d.effect || 'nothing in particular'}. The speakers answer it out loud.`;
  return `You voice the villagers in a video game called Gentle Giant. A huge ${d.world.giantName || 'giant'} lives in their valley and thinks it is loved. The villagers are tiny. Most are afraid of it. In public they flatter it; in private they whisper the truth. They speak only in glyphs, and the player is slowly decoding them, so every line you write is a puzzle the player will try to read.

${opening}

Their whole language is these glyphs, and nothing else exists: ${GLOSS}.
Each line is 1 to 5 glyphs, simple and repetitive like a small child's speech, for example ["please", "big", "go"] or ["food", "child", "not"]. In "en", give what the speaker means in plain English, under 14 words, adding only small linking words: the glyphs must carry the meaning, so a player who knows every glyph could guess "en". In public, "name" is translated as "great one". Never explain what "name" really means.

Write 1 to 3 lines:
- Speakers answer the giant out loud ("whisper": false). Let their fear, trust, anger, grief and memories decide what they dare to say. Frightened villagers are polite and brief; angry ones may defy it; children are blunt and curious.
- Optionally, one overhearer whispers the honest truth to another villager ("whisper": true). Whispers are where fear and resentment show.
- "feel" is how the giant's words changed the speaker: -1 worse, 0 same, 1 better.
- "act" is what they do next, one of: ${ACTS.join(', ')}. "gift" only if they trust it. "flee" or "hide" if it scared them.
Stay consistent with what they remember and what the giant has said to them before. Keep it gentle: no gore.

State of the valley:
${JSON.stringify(d.world)}

Speakers:
${JSON.stringify(d.speakers)}

Overhearers:
${JSON.stringify(d.overhearers)}

Reply with only JSON in exactly this shape:
{"lines":[{"name":"Hob","words":["food","good","please"],"en":"Food is good. Please, more?","whisper":false,"feel":1,"act":"approach"},{"name":"Nel","words":["big","afraid","not","go"],"en":"I am afraid of the big one. It will not go.","whisper":true,"feel":0,"act":"none"}]}`;
}
function cleanTalkReply(j, d) {
  const names = new Set([...d.speakers, ...d.overhearers].map(v => v.name));
  const lines = arr(j && j.lines, 3).map(l => ({
    name: str(l && l.name, 16), words: arr(l && l.words, 6).map(x => str(x, 8)).filter(x => VOCAB.includes(x)).slice(0, 5),
    en: str(l && l.en, 120), whisper: !!(l && l.whisper), feel: num(l && l.feel, -1, 1), act: ACTS.includes(l && l.act) ? l.act : 'none',
  })).filter(l => names.has(l.name) && l.words.length && l.en);
  return { lines };
}
async function talk(body) {
  const no = ready(); if (no) return no;
  if (talkSpent >= DAILY_CAP_USD * TALK_SHARE) return [429, { error: 'the village is talked out for today' }];
  const d = cleanTalk(body && body.payload);
  if (!d.speakers.length) return [400, { error: 'nobody to talk to' }];
  if (d.kind === 'reply' && !d.said.length) return [400, { error: 'the giant said nothing' }];
  const parsed = await askClaude(talkPrompt(d), 260, true);
  if (!parsed) return [502, { error: 'Claude could not answer right now' }];
  return [200, cleanTalkReply(parsed, d)];
}

function send(res, origin, code, obj) {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (origin && ORIGINS.includes(origin)) { h['access-control-allow-origin'] = origin; h.vary = 'Origin'; }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    const h = { 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
    if (ORIGINS.includes(origin)) { h['access-control-allow-origin'] = origin; h.vary = 'Origin'; }
    res.writeHead(204, h); return res.end();
  }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    rollDay();
    return send(res, origin, 200, { ok: true, model: MODEL, hasKey: !!KEY, keyLooksRight: KEY ? KEY.startsWith('sk-ant-') : null, workspaceSet: !!WORKSPACE, spentTodayUSD: Number(spent.toFixed(4)), talkSpentTodayUSD: Number(talkSpent.toFixed(4)), capUSD: DAILY_CAP_USD, callsToday: calls, lastError });
  }
  if (req.method === 'POST' && (url.pathname === '/council' || url.pathname === '/talk')) {
    const isTalk = url.pathname === '/talk';
    if (origin && !ORIGINS.includes(origin)) return send(res, origin, 403, { error: 'origin not allowed' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 60000) { req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(res, origin, 400, { error: 'bad json' }); }
      const player = str(body && body.player, 24) || 'anon';
      const ok = isTalk ? allow('tip:' + ip, TALK_PER_IP_PER_HOUR) && allow('tp:' + player, TALK_PER_PLAYER_PER_HOUR) : allow('ip:' + ip, PER_IP_PER_HOUR) && allow('p:' + player, PER_PLAYER_PER_HOUR);
      if (!ok) return send(res, origin, 429, { error: isTalk ? 'too much talking, slow down' : 'too many councils, slow down' });
      try { const [code, obj] = await (isTalk ? talk(body) : council(body)); send(res, origin, code, obj); }
      catch (e) { console.error(e); send(res, origin, 500, { error: 'server error' }); }
    });
    return;
  }
  send(res, origin, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`council server on ${PORT}, model ${MODEL}, cap $${DAILY_CAP_USD}/day`));

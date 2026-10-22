import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STOP = new Set([
  "what","is","the","of","for","show","give","please","data","details","detail",
  "plant","system","equipment","and","or","to","in","on","a","an","my","our"
]);

function norm(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9&/._ -]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(q: string) {
  return [...new Set(norm(q).split(" ").filter(x => x.length > 2 && !STOP.has(x)))].slice(0, 8);
}

function queryAliases(q:string, scope:string) {
  const n = norm(q);
  const out = new Set<string>();

  const add = (...xs:string[]) => xs.forEach(x => out.add(norm(x)));

  if (scope === "CHP") {
    if (/\b(primary screen|pre screen|pre-screen)\b/.test(n)) {
      add("primary screen","pre screen","pre-screen","vibrating screen pre-screen","vibrating screen");
    }
    if (/\b(secondary screen|post screen|post-screen)\b/.test(n)) {
      add("secondary screen","post screen","post-screen","vibrating screen post-screen","vibrating screen");
    }
    if (/\bvibrating screen\b/.test(n) &&
        !/\b(primary|secondary|pre[- ]?screen|post[- ]?screen)\b/.test(n)) {
      add("vibrating screen","primary screen","pre screen","pre-screen","secondary screen","post screen","post-screen");
    }
    if (/\bbc ?-? ?3\b/.test(n)) add("bc-3","bc 3","belt conveyor 3");
    if (/\bbc ?-? ?2\b/.test(n)) add("bc-2","bc 2","belt conveyor 2");
    if (/\bbc ?-? ?1\b/.test(n)) add("bc-1","bc 1","belt conveyor 1");
  }

  if (scope === "WTP / ETP") {
    if (/\binitial filling pump\b/.test(n)) add("initial filling pump","boiler initial filling pump");
  }

  if (scope === "CFBC Boiler") {
    if (/\bdcf\b|drag chain feeder/.test(n)) add("dcf","drag chain feeder","drag chain feeders");
    if (/\bbfp\b|boiler feed pump|bfw pump/.test(n)) add("bfp","bfw pump","boiler feed pump");
    if (/\bpa fan\b|primary air fan/.test(n)) add("pa fan","primary air fan");
    if (/\bsa fan\b|secondary air fan/.test(n)) add("sa fan","secondary air fan");
    if (/\bid fan\b|induced draft fan/.test(n)) add("id fan","induced draft fan");
  }

  return [...out].filter(Boolean);
}

function isBarePlantLookup(q:string) {
  const n = norm(q);
  if (!n) return false;
  if (/\b(what|why|how|when|where|who|define|meaning|explain|latest|method|methods|standard|standards|limit|limits|norm|norms|cpcb|moef|moefcc)\b/.test(n)) return false;
  return n.split(/\s+/).filter(Boolean).length <= 5;
}

function expandedSearchTerms(q:string, scope:string) {
  const out = new Set<string>(tokens(q));
  for (const a of queryAliases(q, scope)) {
    out.add(a);
    for (const t of tokens(a)) out.add(t);
  }
  return [...out].filter(Boolean).slice(0, 14);
}

function inferScope(q: string) {
  const n = norm(q);
  const routes = [
    ["Steam Turbine", ["steam turbine","turbine","governor","turbine gear","gearbox","gear box"]],
    ["Air Cooled Condenser", ["air cooled condenser","acc"]],
    ["CFBC Boiler", ["cfbc","boiler","bfp","bfw pump","pa fan","sa fan","id fan","esp","superheater","economizer","economiser","evaporator","steam drum","bed material"]],
    ["CHP", ["chp","coal handling"]],
    ["AHS", ["ahs","ash handling"]],
    ["WTP / ETP", ["wtp","etp","water treatment","effluent treatment"]],
    ["Cooling Tower", ["cooling tower"]],
    ["Electrical", ["transformer","generator","switchgear","electrical"]],
    ["C&I", ["c&i","instrument","transmitter","dcs","plc"]],
    ["Fire Fighting & Safety", ["fire fighting","firefighting","fire hydrant","hydrant","sprinkler","fire extinguisher","safety","emergency response"]],
  ];
  return routes.find(([, terms]) => terms.some((t: string) => n.includes(t)))?.[0] || "";
}

function splitPages(extracted = "") {
  const parts = String(extracted).split(/\[\[PAGE (\d+)\]\]\n?/g);
  const out: Array<{page:number|null,text:string}> = [];
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ page: Number(parts[i]), text: parts[i + 1] || "" });
  }
  if (!out.length && extracted) out.push({ page: null, text: extracted });
  return out;
}

// Split every long extracted page/sheet into overlapping evidence windows.
// DOCX, TXT, spreadsheet extracts and scanned/OCR pages can all exceed the
// per-source context limit; ranking only the start loses later table rows.
function evidenceWindows(raw:string, maxChars=3300, overlap=700) {
  const text=String(raw||"").replace(/\r\n/g,"\n").trim();
  if (!text) return [];
  if (text.length<=maxChars) return [{text,offset:0}];
  const result:Array<{text:string,offset:number}> = [];
  let start=0;
  while(start<text.length && result.length<180){
    let end=Math.min(text.length,start+maxChars);
    if(end<text.length){
      // Prefer paragraph/row boundaries without sacrificing window coverage.
      const boundary=text.lastIndexOf("\n",end);
      if(boundary>start+Math.floor(maxChars*.72))end=boundary+1;
    }
    result.push({text:text.slice(start,end).trim(),offset:start});
    if(end>=text.length)break;
    let next=Math.max(start+1,end-overlap);
    // Start at a nearby row/paragraph boundary if possible.
    const boundary=text.indexOf("\n",next);
    if(boundary>=0 && boundary<next+180)next=boundary+1;
    start=next;
  }
  return result;
}

// A requested reservoir level must be grounded in a reservoir/tank record and
// in the requested level. Generic "rated capacity" from another machine is not evidence.
function reservoirLevelEvidence(question:string, text:string, fileName:string, sourcePath:string) {
  const q = norm(question);
  if (!/\b(reservoir|water tank|storage tank)\b/.test(q) ||
      !/\b(level|mtr|meter|metre|capacity|volume|stock)\b/.test(q)) return true;

  const hay = norm([text, fileName, sourcePath].join(" "));
  if (!/\b(reservoir|water tank|storage tank|level.volume|level volume|usable stock)\b/.test(hay)) return false;

  // For numeric level queries, do not substitute a different level or equipment rating.
  const requested = q.match(/\b(\d+(?:\.\d+)?)\s*(?:mtr|meter|metre|meters|metres|m)\b/) ||
    q.match(/\b(?:level|at)\s*(\d+(?:\.\d+)?)\b/);
  if (!requested) return true;
  const level = requested[1].replace(".", "\\.");
  const levelPattern = new RegExp("(^|[^0-9.])" + level + "(?![0-9.])");
  return levelPattern.test(hay);
}

// For reservoir level-to-capacity requests, require explicit level and volume evidence.
// A page mentioning a reservoir and an unrelated equipment capacity is insufficient.
function hasReservoirLevelVolumeEvidence(question:string, sourceText:string) {
  const q = norm(question);
  if (!/\b(reservoir|water tank|storage tank)\b/.test(q)) return true;
  const requested = q.match(/\b(\d+(?:\.\d+)?)\s*(?:mtr|meter|metre|meters|metres|m)\b/) ||
    q.match(/\b(?:level|at)\s*(\d+(?:\.\d+)?)\b/);
  if (!requested) return true;
  const text = String(sourceText || "").replace(/\s+/g, " ").toLowerCase();
  if (!/\b(reservoir|water tank|storage tank)\b/.test(text)) return false;
  const level = requested[1].replace(".", "\\.");
  const levelMatch = new RegExp("(?:\\b" + level + "\\s*(?:mtr|meters?|metres?|m)\\b|\\b(?:level|at)\\s*[:=-]?\\s*" + level + "(?![0-9.]))", "g");
  for (const match of text.matchAll(levelMatch)) {
    const nearby = text.slice(Math.max(0, match.index - 85), match.index + match[0].length + 85);
    if (/\b(?:\d[\d,.]*\s*(?:m3|m³|cu\.?\s*m|cubic\s*met(?:er|re)s?|kl|kilolit(?:er|re)s?|lit(?:er|re)s?|ltr|ltrs))\b/i.test(nearby)) return true;
  }
  return false;
}

// Resolve numeric reservoir levels from the source spreadsheet's actual table rows.
// This avoids treating comma-separated spreadsheet columns as unlabelled prose.
function exactReservoirCapacity(question:string, docs:any[]) {
  const q = norm(question);
  if (!/\b(reservoir|water tank|storage tank)\b/.test(q) ||
      !/\b(capacity|volume|stock|level|mtr|meter|metre)\b/.test(q)) return null;
  const requested = q.match(/\b(\d+(?:\.\d+)?)\s*(?:mtr|meter|metre|meters|metres|m)\b/) ||
    q.match(/\b(?:level|at)\s*(\d+(?:\.\d+)?)\b/);
  if (!requested) return null;
  const target = Number(requested[1]);
  if (!Number.isFinite(target)) return null;
  const suctionDatum = /\b(suction datum|datum level|pump suction)\b/.test(q);
  for (const doc of docs) {
    if (!/\.(xlsx|xls|csv)$/i.test(String(doc.file_name||""))) continue;
    const raw = String(doc.extracted_text||"");
    if (!/raw water reservoir/i.test(raw) ||
        !/bed depth\s*\(m\)\s*,\s*usable stock\s*\(m[³3]\)\s*,\s*total volume\s*\(m[³3]\)\s*,\s*suction datum level\s*\(m\)/i.test(raw)) continue;
    for (const line of raw.split(/\r?\n/)) {
      const fields = line.split(",").map(x=>x.trim());
      if (fields.length < 4) continue;
      const bed = Number(fields[0].replace(/\s*m\s*$/i,""));
      const usable = Number(fields[1]);
      const total = Number(fields[2]);
      const datum = Number(fields[3].replace(/\s*m\s*$/i,""));
      if (![bed,usable,total,datum].every(Number.isFinite)) continue;
      if (Math.abs((suctionDatum?datum:bed)-target)>0.00001) continue;
      const format=(n:number)=>n.toLocaleString("en-US",{maximumFractionDigits:1});
      return {
        answer_lines:["Total Volume : "+format(total)+" m³","Usable Stock : "+format(usable)+" m³"],
        sources:[{document_id:doc.id,file_name:doc.file_name,page:1,page_end:1}],
        web_sources:[],
        source_type:"plant"
      };
    }
  }
  return null;
}

function scoreChunk(question: string, text: string, fileName: string, category: string, sourcePath: string) {
  if (!reservoirLevelEvidence(question, text, fileName, sourcePath)) return 0;
  const q = norm(question);
  const ts = expandedSearchTerms(question, category);
  const aliases = queryAliases(question, category);
  const hay = norm([text, fileName, category, sourcePath].join(" "));
  let score = 0;

  if (q && hay.includes(q)) score += 160;
  for (const a of aliases) {
    if (a && hay.includes(a)) score += 140;
  }
  for (const t of ts) {
    const count = hay.split(t).length - 1;
    score += Math.min(count, 8) * 22;
    if (norm(fileName).includes(t)) score += 50;
    if (norm(sourcePath).includes(t)) score += 35;
  }

  // Avoid common sub-equipment mix-ups unless explicitly requested.
  const nq = norm(question);
  if (/\bbfp\b|bfw pump|boiler feed pump/.test(nq) && !/\bmotor\b/.test(nq) && /motor/.test(norm(fileName + " " + sourcePath))) score -= 220;
  if (/\b(pa|sa|id) fan\b/.test(nq) && !/\bmotor\b/.test(nq) && /motor/.test(norm(fileName + " " + sourcePath))) score -= 220;

  return score;
}

function extractResponseText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const c of item?.content || []) {
      if ((c?.type === "output_text" || c?.type === "text") && typeof c?.text === "string") return c.text;
    }
  }
  return "";
}

function collectWebSources(payload: any) {
  const out: Array<{title:string,url:string}> = [];
  const seen = new Set<string>();

  const push = (title:any, url:any) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ title:String(title || u).trim().slice(0,160), url:u });
  };

  for (const item of payload?.output || []) {
    for (const c of item?.content || []) {
      for (const a of c?.annotations || []) {
        const uc = a?.url_citation || a;
        if (a?.type === "url_citation" || uc?.url) push(uc?.title, uc?.url);
      }
    }
    for (const src of item?.sources || []) push(src?.title, src?.url);
  }

  for (const src of payload?.sources || []) push(src?.title, src?.url);
  return out.slice(0, 6);
}

function isNoExact(lines:any) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return true;
  return list.every((x:any) => /no exact plant-document match found/i.test(String(x || "")));
}

function isRegulatoryQuery(q:string) {
  return /\b(limit|limits|standard|standards|norm|norms|cpcb|moef|moefcc|emission|emissions|sox|so2|nox|no2|pm|particulate)\b/i.test(q);
}

function countWebSearchCalls(payload:any) {
  return (payload?.output || []).filter((x:any) =>
    String(x?.type || "").toLowerCase().includes("web_search_call")
  ).length;
}

function usageFromResponse(payload:any, webSearchCalls=0) {
  const u = payload?.usage || {};
  return {
    input_tokens: Number(u?.input_tokens || 0),
    cached_input_tokens: Number(u?.input_tokens_details?.cached_tokens || 0),
    output_tokens: Number(u?.output_tokens || 0),
    web_search_calls: Number(webSearchCalls || 0)
  };
}

function combineUsage(...items:any[]) {
  return items.reduce((a:any, x:any) => ({
    input_tokens:a.input_tokens + Number(x?.input_tokens || 0),
    cached_input_tokens:a.cached_input_tokens + Number(x?.cached_input_tokens || 0),
    output_tokens:a.output_tokens + Number(x?.output_tokens || 0),
    web_search_calls:a.web_search_calls + Number(x?.web_search_calls || 0)
  }), {input_tokens:0,cached_input_tokens:0,output_tokens:0,web_search_calls:0});
}

// Conservative list-rate estimate used by the Admin dashboard.
// Actual OpenAI Billing remains authoritative.
function estimateCostUsd(u:any) {
  const input = Number(u?.input_tokens || 0);
  const cached = Math.min(input, Number(u?.cached_input_tokens || 0));
  const uncached = Math.max(0, input - cached);
  const output = Number(u?.output_tokens || 0);
  const web = Number(u?.web_search_calls || 0);
  return (
    (uncached * 0.10 / 1_000_000) +
    (cached * 0.01 / 1_000_000) +
    (output * 0.50 / 1_000_000) +
    (web * 0.01)
  );
}

async function webFallback(openaiKey:string, model:string, question:string, scope:string) {
  const regulatory = isRegulatoryQuery(question);
  const webInstructions = `
You are PowerPlant360, a thermal power-plant engineering assistant.
The selected department is: ${scope}.

The plant's private documents did not contain a verified answer, so answer from current public web sources.
Rules:
- Clearly treat the answer as general/online information, not as verified plant-specific data.
- Never claim an online value is this plant's actual value.
- If the question asks for a plant-specific make, model, setting, rating, serial number, exact design value, or exact operating limit, state that the plant-specific value is not verified and then give only useful general context if available.
- Prefer manufacturer/OEM documentation, standards bodies, government/academic sources, and established engineering references.
- For ordinary questions: return exactly ONE concise plain-text line, normally under 35 words.
- For regulatory/limit/standard/norm/emission questions: return 2–4 plain-text parameter lines. Start each line with one of these exact labels when relevant: "SO₂/SOx :", "NOx :", "PM :", "Applicability :". Never place two labels on the same line.
- Do not use bullets, markdown, headings, bold markers, tables, inline URLs, or source names in the answer text.
- Source links will be shown separately by the app.
- If the question asks about limits, standards, norms, CPCB/MoEFCC, SO₂/SOx, NOx, PM or emissions, prioritize official Indian sources such as CPCB and MoEFCC over secondary sites.
- For such regulatory questions, include the applicability condition in the same line (for example commissioning period, unit size/capacity, fuel/category, or rule/amendment) whenever the source provides it.
- Never present one generic emission limit as universally applicable when the regulation has multiple categories.
`.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${openaiKey}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model,
      instructions:webInstructions,
      tools:[{ type:"web_search", search_context_size:"medium" }],
      tool_choice:"auto",
      input:`Department: ${scope}\nRegulatory/limit question: ${regulatory ? "yes" : "no"}\nQuestion: ${question}`
    })
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("Plant AI web search failed", res.status, t.slice(0,800));
    throw new Error(`Web search failed (${res.status}): ${t.slice(0,500)}`);
  }

  const payload = await res.json();
  const answer = extractResponseText(payload).trim();

  const cleanWebLine = (value:string) => String(value || "")
    .replace(/\[[^\]]+\]\([^\)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/【[^】]+】/g, "")
    .replace(/\[(?:source\s*)?\d+\]/gi, "")
    .replace(/\((?:source\s*)?\d+\)/gi, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/^[\s•*-]+/, "")
    .replace(/[\*_#>~]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+0\s*$/g, "")
    .trim();

  let answerLines:string[] = [];

  if (regulatory) {
    const regulatoryText = answer
      .replace(/\(\s*\)/g, "")
      .replace(/\s+0\s+(?=(?:SO₂\s*\/\s*SOx|SO₂|SO2|SOx|NOx|NO₂|NO2|PM|Applicability)\s*:)/gi, "\n")
      .replace(/;\s*(?=(?:SO₂\s*\/\s*SOx|SO₂|SO2|SOx|NOx|NO₂|NO2|PM|Applicability)\s*:)/gi, "\n")
      .replace(/\s+(?=(?:SO₂\s*\/\s*SOx|SO₂|SO2|SOx|NOx|NO₂|NO2|PM|Applicability)\s*:)/gi, "\n");

    answerLines = regulatoryText
      .split(/\n+/)
      .map(cleanWebLine)
      .filter(Boolean);
  } else {
    const cleanLine = cleanWebLine(answer);
    answerLines = [cleanLine || "No reliable online reference found."];
  }

  return {
    answer_lines: answerLines.length ? answerLines : ["No reliable online reference found."],
    sources: [],
    web_sources: collectWebSources(payload),
    source_type: "web",
    display_mode: regulatory ? "parameter_lines" : "one_line",
    scope,
    __usage: usageFromResponse(payload, countWebSearchCalls(payload))
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type":"application/json" }});
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    const model = Deno.env.get("OPENAI_MODEL") || "gpt-6-luna";

    if (!openaiKey) {
      return new Response(JSON.stringify({ error: "AI_NOT_CONFIGURED" }), { status: 503, headers: { ...corsHeaders, "Content-Type":"application/json" }});
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: auth } }
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type":"application/json" }});
    }

    let adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      adminKey = keys?.default || adminKey;
    } catch (_) {}
    const supabaseAdmin = adminKey ? createClient(supabaseUrl, adminKey) : null;

    let callerRole = "";
    if (supabaseAdmin) {
      const { data: roleRow } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      callerRole = String(roleRow?.role || "");
    }
    const allowOnlineWeb = callerRole === "admin";
    const allowedPlantRoles = new Set(["admin","engineer","viewer"]);

    if (!allowedPlantRoles.has(callerRole)) {
      return new Response(JSON.stringify({ error:"PowerPlant360 role required." }), {
        status:403,
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    const recordUsage = async (usage:any, sourceType:string, scopeValue:string) => {
      if (!supabaseAdmin || !usage) return;
      const row = {
        user_id:userData.user.id,
        scope:scopeValue,
        source_type:sourceType,
        model,
        input_tokens:Number(usage.input_tokens || 0),
        cached_input_tokens:Number(usage.cached_input_tokens || 0),
        output_tokens:Number(usage.output_tokens || 0),
        web_search_calls:Number(usage.web_search_calls || 0),
        estimated_cost_usd:Number(estimateCostUsd(usage).toFixed(6))
      };
      const { error: usageError } = await supabaseAdmin.from("api_usage").insert(row);
      if (usageError) console.error("api_usage insert failed", usageError.message);
    };

    const body = await req.json().catch(() => ({}));
    const question = String(body?.question || "").trim();
    const requestedScope = String(body?.scope || "").trim();
    const mode = String(body?.mode || "plant").trim().toLowerCase();
    if (!question) {
      return new Response(JSON.stringify({ error: "Question required" }), { status: 400, headers: { ...corsHeaders, "Content-Type":"application/json" }});
    }

    if (!requestedScope) {
      return new Response(JSON.stringify({ error: "Department scope required" }), {
        status:400,
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    const scope = requestedScope;
    const reservoirDualValueQuery =
      /\b(reservoir|storage tank|water tank|tank capacity)\b/i.test(question) &&
      /\b(capacity|level|volume|stock|mtr|meter|metre)\b/i.test(question);

    if (mode === "web") {
      if (!allowOnlineWeb) {
        return new Response(JSON.stringify({ error:"Online search is available to Admin only." }), {
          status:403,
          headers:{ ...corsHeaders, "Content-Type":"application/json" }
        });
      }
      const online = await webFallback(openaiKey, model, question, scope);
      await recordUsage(online.__usage, "web", scope);
      delete online.__usage;
      return new Response(JSON.stringify(online), {
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    if (mode !== "plant") {
      return new Response(JSON.stringify({ error:"Invalid search mode." }), {
        status:400,
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    const ts = expandedSearchTerms(question, scope);
    const barePlantLookup = isBarePlantLookup(question);

    const columns = "id,file_name,category,document_type,extracted_text,page_count,metadata";
    const safeTerms = ts.slice(0,8).map(t=>t.replace(/[,%()]/g,"").trim()).filter(Boolean);
    const clauses = safeTerms.flatMap(t=>[
      `extracted_text.ilike.%${t}%`, `file_name.ilike.%${t}%`
    ]);
    async function scopedDocs(category:string, limit:number){
      let q = supabase.from("documents").select(columns)
        .eq("processing_status","ready").eq("category",category)
        .not("extracted_text","is",null);
      if(clauses.length)q=q.or(clauses.join(","));
      let {data,error}=await q.limit(limit);
      if(error)return {data,error};
      if(!data?.length){
        const retry=await supabase.from("documents").select(columns)
          .eq("processing_status","ready").eq("category",category)
          .not("extracted_text","is",null).limit(limit);
        data=retry.data;error=retry.error;
      }
      return {data,error};
    }
    // Shared files are added for every department, but never replace its own
    // document candidates. A separate query preserves each retrieval budget.
    const [departmentResult, commonResult] = await Promise.all([
      scopedDocs(scope,40), scopedDocs("Common",20)
    ]);
    const error = departmentResult.error || commonResult.error;
    const docs = [
      ...(departmentResult.data||[]),
      ...(scope==="Common"?[]:(commonResult.data||[]))
    ];

    if (error) throw error;
    if (!docs?.length) {
      return new Response(JSON.stringify({
        answer_lines:["No exact plant-document match found."],
        sources:[],
        web_sources:[],
        source_type:"plant",
        scope
      }), {
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    // Prefer exact reservoir spreadsheet rows over fuzzy text search or AI inference.
    const isNumericReservoir = /\b(reservoir|water tank|storage tank)\b/.test(norm(question)) &&
      /\b\d+(?:\.\d+)?\s*(?:mtr|meter|metre|meters|metres|m)\b/.test(norm(question));
    let reservoirDocs = docs;
    if (isNumericReservoir) {
      const { data: spreadsheetDocs, error: spreadsheetError } = await supabase
        .from("documents")
        .select("id,file_name,category,extracted_text")
        .eq("processing_status", "ready")
        .eq("category", scope)
        .ilike("file_name", "%reservoir%")
        .not("extracted_text", "is", null)
        .limit(15);
      if (spreadsheetError) throw spreadsheetError;
      reservoirDocs = spreadsheetDocs || docs;
    }
    const reservoirRow = exactReservoirCapacity(question, reservoirDocs);
    if (reservoirRow) {
      await recordUsage(null, "plant", scope);
      return new Response(JSON.stringify({ ...reservoirRow, scope }), {
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    const chunks: Array<any> = [];
    const pageLookup = new Map<string, Map<number, string>>();

    for (const d of docs) {
      const sourcePath = String(d?.metadata?.source_path || "");
      const pages = splitPages(d.extracted_text || "");
      const docPages = new Map<number, string>();

      for (const p of pages) {
        if (p.page == null) continue;
        const fullText = String(p.text || "").replace(/\s+/g, " ").trim();
        if (fullText) docPages.set(Number(p.page), fullText);
      }
      pageLookup.set(String(d.id), docPages);

      for (const p of pages) {
        for (const window of evidenceWindows(p.text || "")) {
          const text = window.text.replace(/\s+/g, " ").trim();
          if (!text) continue;
          const baseScore = scoreChunk(question, text, d.file_name || "", scope, sourcePath);
          // Favor exact multiword phrases within the actual evidence window,
          // not just individual terms appearing far apart in a long document.
          const phrase = tokens(question).join(" ");
          const phraseBoost = phrase.split(" ").length >= 2 && norm(text).includes(phrase) ? 130 : 0;
          // Department evidence wins on close relevance; Common remains searchable everywhere.
          const score = baseScore + phraseBoost - (d.category === "Common" ? 25 : 0);
          if (score <= 0) continue;
          chunks.push({
            score,
            document_id:d.id,
            file_name:d.file_name,
            category:d.category,
            document_type:d.document_type,
            page:p.page,
            offset:window.offset,
            text:text.slice(0, 3400)
          });
        }
      }
    }

    chunks.sort((a,b) => b.score - a.score);

    // Deduplicate overlapping windows, not entire document pages.
    // One DOCX often has a single extracted page containing dozens of tables.
    const ranked:Array<any> = [];
    for (const c of chunks) {
      const overlaps = ranked.some(x =>
        x.document_id === c.document_id &&
        x.page === c.page &&
        Math.abs(Number(x.offset||0) - Number(c.offset||0)) < 1400
      );
      if (overlaps) continue;
      if (ranked.filter(x=>x.document_id===c.document_id).length>=3)continue;
      ranked.push(c);
      if (ranked.length >= 8) break;
    }

    // Technical tables often continue onto the next PDF page. Append that page
    // to the same source window so equipment name + continuation specs stay together.
    const top = ranked.map(c => {
      const page = Number(c.page);
      const pages = pageLookup.get(String(c.document_id));
      const nextText = Number.isFinite(page) && (c.offset||0)===0 && c.text.length<2800
        ? (pages?.get(page + 1) || "") : "";
      const hasNext = Boolean(nextText);
      const text = hasNext
        ? `[[PAGE ${page}]] ${c.text}\n[[PAGE ${page + 1} — CONTINUATION]] ${nextText.slice(0, 3200)}`
        : c.text;
      return {
        ...c,
        text,
        page_end: hasNext ? page + 1 : page
      };
    });

    if (!top.length) {
      return new Response(JSON.stringify({
        answer_lines:["No exact plant-document match found."],
        sources:[],
        web_sources:[],
        source_type:"plant",
        scope
      }), {
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    // Do not send unsupported reservoir level queries to the language model.
    // A general equipment list can mention the reservoir but give no level/volume data.
    if (!top.some(c => hasReservoirLevelVolumeEvidence(question, c.text))) {
      return new Response(JSON.stringify({
        answer_lines:["No exact plant-document match found."],
        sources:[],
        web_sources:[],
        source_type:"plant",
        scope
      }), { headers:{ ...corsHeaders, "Content-Type":"application/json" } });
    }

    const context = top.map((c, i) =>
      `[SOURCE ${i}]\nEquipment: ${c.category || ""}\nDocument: ${c.file_name || ""}\nPages: ${c.page ?? ""}${c.page_end && c.page_end !== c.page ? "–" + c.page_end : ""}\nText: ${c.text}`
    ).join("\n\n");

    const instructions = `
You are PowerPlant360, a thermal power-plant document assistant.
Answer ONLY from the supplied plant-document context. Do not use outside knowledge for plant-specific values.
If the context does not support the requested answer, say exactly: "No exact plant-document match found."

Rules:
- One requested parameter/value: return exactly ONE concise line "Parameter : Value". Do not add related fields, alternate interpretations, commentary, notes, source discussion, or reasoning.
- RESERVOIR/TANK EXCEPTION: when "Reservoir dual-value query" is YES and the supplied plant context contains both values at the requested level, ALWAYS return exactly two separate lines: "Total Volume : <value>" and "Usable Stock : <value>". Never omit either value.
- For reservoir/tank level queries, use only values explicitly shown for that requested level. Do not interpolate, calculate, estimate, or mix values from another level.
- Multiple values/specifications explicitly requested by the user: return one parameter per line.
- If the question is only an equipment/component name (for example "initial filling pump") and does not ask for one specific field, return ALL clearly associated technical specifications available in that equipment's table/record, one parameter per line.
- CFBC Boiler terminology: "DCF" means "Drag Chain Feeder" / "Drag Chain Feeders". For a bare DCF query, return "DCF : Drag Chain Feeder(s)" when supported by the supplied plant context.
- CHP terminology: "Pre-Screen" and "Primary Screen" are the same equipment; "Post-Screen" and "Secondary Screen" are the same equipment.
- If the user asks only for "vibrating screen" and the supplied context contains both Pre/Primary and Post/Secondary screen records, return both records and clearly label them "Primary / Pre-Screen" and "Secondary / Post-Screen".
- A table/record may continue across an adjacent PDF page. Treat a labelled continuation page as part of the same equipment record when the supplied source window shows that continuity.
- Keep parent-equipment and motor data clearly labelled separately, for example "Pump Make", "Pump Type", "Motor Make", "Motor Type".
- Never dump raw PDF paragraphs.
- Remove company headers, page headers, revision tables, and irrelevant text.
- Keep equipment identity strict: pump != pump motor; fan != fan motor; actuator/bearing/gearbox data must not replace parent-equipment data unless asked.
- Use units exactly as supported by the context.
- Do not invent, infer, average, or correct values.
- For limits/standards/norms/emissions questions, answer from plant documents ONLY if an explicit numeric limit and its applicability/condition are present in the supplied context. Otherwise return exactly: "No exact plant-document match found."
- Return JSON only in this shape:
{"answer_lines":["..."],"source_indices":[0,1]}
source_indices must contain only the source numbers that directly support the answer.
`.trim();

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${openaiKey}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model,
        instructions,
        input:`Question: ${question}\nReservoir dual-value query: ${reservoirDualValueQuery ? "YES" : "NO"}\nKnown query aliases: ${queryAliases(question, scope).join(", ") || "none"}\n\nPlant-document context:\n${context}`,
        text:{
          verbosity:"low",
          format:{
            type:"json_schema",
            name:"plant_document_answer",
            strict:true,
            schema:{
              type:"object",
              properties:{
                answer_lines:{
                  type:"array",
                  items:{type:"string"}
                },
                source_indices:{
                  type:"array",
                  items:{type:"integer"}
                }
              },
              required:["answer_lines","source_indices"],
              additionalProperties:false
            }
          }
        }
      })
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("Plant AI OpenAI request failed", aiRes.status, t.slice(0,800));
      throw new Error(`AI request failed (${aiRes.status}): ${t.slice(0,500)}`);
    }

    const ai = await aiRes.json();
    const plantUsage = usageFromResponse(ai, 0);
    const raw = extractResponseText(ai).trim();

    let parsed:any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("Plant AI structured output parse failed", raw.slice(0,500));
    }

    const cleanAnswerLine = (value:any) => String(value || "")
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const looksLikeMetaText = (value:string) =>
      /\b(source_indices|need json|json valid|shouldn'?t|maybe return|could label|schema|internal reasoning|analysis:)\b/i.test(value);

    let answerLinesSafe = Array.isArray(parsed?.answer_lines)
      ? parsed.answer_lines.map(cleanAnswerLine).filter(Boolean)
      : [];

    answerLinesSafe = answerLinesSafe.filter((line:string) => !looksLikeMetaText(line));

    const sourceIndices = Array.isArray(parsed?.source_indices)
      ? parsed.source_indices.filter((x:any) => Number.isInteger(x) && x >= 0 && x < top.length)
      : [];
    const seen = new Set<string>();
    const sources = sourceIndices
      .map((i:number) => top[i])
      .filter(Boolean)
      .filter((x:any) => {
        if (seen.has(x.document_id)) return false;
        seen.add(x.document_id);
        return true;
      })
      .slice(0,3)
      .map((x:any) => ({
        document_id:x.document_id,
        file_name:x.file_name,
        page:x.page,
        page_end:x.page_end || x.page
      }));

    const answerLines = answerLinesSafe;
    // Reject bare ratings such as "Capacity: 3000" for a level-specific
    // reservoir volume request. The answer must identify a volume unit.
    const reservoirLevelAsked = /\b(reservoir|water tank|storage tank)\b/i.test(question) &&
      (/\b\d+(?:\.\d+)?\s*(?:mtr|meter|metre|meters|metres|m)\b/i.test(question) ||
       /\b(?:level|at)\s*\d+(?:\.\d+)?\b/i.test(question));
    const verifiedAnswerUnits = !reservoirLevelAsked ||
      answerLines.some((line:string) => /\b(?:m3|m³|cu\.?\s*m|cubic\s*met(?:er|re)s?|kl|kilolit(?:er|re)s?|lit(?:er|re)s?|ltr|ltrs)\b/i.test(line));
    if (!parsed || !answerLines.length || isNoExact(answerLines) || !verifiedAnswerUnits) {
      await recordUsage(plantUsage, "plant", scope);
      return new Response(JSON.stringify({
        answer_lines:["No exact plant-document match found."],
        sources:[],
        web_sources:[],
        source_type:"plant",
        scope
      }), {
        headers:{ ...corsHeaders, "Content-Type":"application/json" }
      });
    }

    await recordUsage(plantUsage, "plant", scope);

    return new Response(JSON.stringify({
      answer_lines:answerLines,
      sources,
      web_sources:[],
      source_type:"plant",
      scope
    }), {
      headers:{ ...corsHeaders, "Content-Type":"application/json" }
    });
  } catch (err) {
    console.error("plant-search error", String(err?.message || err).slice(0,1000));
    return new Response(JSON.stringify({ error:String(err?.message || err) }), {
      status:500,
      headers:{ ...corsHeaders, "Content-Type":"application/json" }
    });
  }
});

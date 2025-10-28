/* src/app/api/disparos/route.ts */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ========= ENV ========= */
const API_BASE = (process.env.UAZAPIGO_API_URL || process.env.UAZAPI_BASE_URL || "").replace(/\/$/, "");
const TOKEN_INSTANCIA = process.env.UAZAPIGO_TOKEN || process.env.UAZAPI_TOKEN || "";

/* ========= Tipos ========= */
type Contact = { nome?: string; numero: string };

type Job = {
  to: string;
  text: string;
  batchId: number;
  msgRowId?: number | null;
  scheduledAt: number; // epoch ms
};

type Batch = { id: number; createdAt: number; jobs: Job[]; inProgress: boolean };
type Store = { lastId: number; batches: Map<number, Batch>; processing: boolean };

type MessageStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "replied" | "error";

type MessageRowInsert = {
  batch_id: number;
  lista_id: number | null;
  lista_nome: string | null;
  numero: string;
  status: MessageStatus;
  error: string | null;
  payload: { text: string };
  created_at: string;    // ISO
  scheduled_at: string;  // ISO
};

type MessageRowSelect = {
  id?: number;
  status: MessageStatus;
  error: string | null;
};

/* ========= Store global (sem any) ========= */
declare global {
  var __DISPAROS_STORE__: Store | undefined;
}
// Garante que este arquivo é um módulo para o augmentation acima funcionar
export {};

const getStore = (): Store => {
  const g = globalThis as typeof globalThis & { __DISPAROS_STORE__?: Store };
  if (!g.__DISPAROS_STORE__) {
    g.__DISPAROS_STORE__ = { lastId: 0, batches: new Map<number, Batch>(), processing: false };
  }
  return g.__DISPAROS_STORE__;
};

/* ========= Utils ========= */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (v: string) => (v || "").replace(/\D+/g, "");
const norm = (n: string) => {
  const d = digits(n ?? "");
  if (!d) return "";
  return d.startsWith("55") ? d : `55${d}`;
};
const now = () => Date.now();
const rand = (a: number, b: number) => {
  let min = Math.min(a, b);
  const max = Math.max(a, b);
  if (min < 0) min = 0;
  return min + Math.floor(Math.random() * (max - min + 1));
};

const getErrMsg = (e: unknown): string => {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    return typeof m === "string" ? m : JSON.stringify(m);
  }
  try {
    return String(e);
  } catch {
    return "Unknown error";
  }
};

/* ========= Janela 08–18 ========= */
const dentroHorario = () => {
  const h = new Date().getHours();
  return h >= 8 && h < 18;
};
const proxDiaUtil0800 = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
};

/* ========= Envio (robusto com múltiplos fallbacks) ========= */
async function sendViaUazapi(to: string, text: string) {
  if (!API_BASE) throw new Error("UAZAPIGO_API_URL ausente");
  if (!TOKEN_INSTANCIA) throw new Error("UAZAPIGO_TOKEN ausente");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    token: TOKEN_INSTANCIA,
  };
  const body = JSON.stringify({ number: to, text });

  const parseBody = async (res: Response): Promise<unknown> => {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        return await res.json();
      } catch {
        // ignore
      }
    }
    const txt = await res.text().catch(() => "");
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  };

  const tryPost = async (url: string) => {
    const res = await fetch(url, { method: "POST", headers, body });
    const data = await parseBody(res);
    return { res, data };
  };

  const normalizeCandidates = (baseOrFull: string) => {
    const clean = baseOrFull.replace(/\/+$/, "");
    const hasEndpoint = /\/(send\/text|message\/text|sendText)$/i.test(clean);
    return hasEndpoint ? [clean] : [`${clean}/send/text`, `${clean}/message/text`, `${clean}/sendText`];
  };

  const tried: { url: string; status: number; data: unknown }[] = [];

  // 1) tenta na BASE configurada
  const firstBatch = normalizeCandidates(API_BASE);
  for (const url of firstBatch) {
    const { res, data } = await tryPost(url);
    tried.push({ url, status: res.status, data });
    if (res.ok) return;

    // 2) se 404, tenta fallback por header ou corpo
    if (res.status === 404) {
      const headerFallback = res.headers.get("x-fallback-url") || res.headers.get("X-Fallback-URL");
      const bodyFallback =
        data &&
        typeof data === "object" &&
        "step" in data &&
        (data as { step?: unknown }).step === "fallback" &&
        "url" in data &&
        typeof (data as { url?: unknown }).url === "string"
          ? String((data as { url?: string }).url)
          : null;

      const fb = headerFallback || bodyFallback;
      if (fb) {
        const fbBatch = normalizeCandidates(fb);
        for (const alt of fbBatch) {
          const r2 = await tryPost(alt);
          tried.push({ url: alt, status: r2.res.status, data: r2.data });
          if (r2.res.ok) return;
        }
      }
    }
  }

  const lines = tried.map((t) => {
    const d = typeof t.data === "string" ? t.data : JSON.stringify(t.data);
    return `${t.status} ${t.url} -> ${d}`;
  });
  throw new Error(`Falha ao enviar (tentativas):\n${lines.join("\n")}`);
}

/* ========= Worker ========= */
async function processBatches() {
  const store = getStore();
  if (store.processing) return;
  store.processing = true;

  try {
    for (const [, batch] of store.batches) {
      if (batch.inProgress) continue;
      batch.inProgress = true;

      while (batch.jobs.length) {
        const job = batch.jobs[0]; // peek
        const wait = Math.max(0, job.scheduledAt - now());
        if (wait > 0) {
          await sleep(Math.min(wait, 1000)); // cochilo curto
          continue;
        }

        // hora de enviar
        batch.jobs.shift();
        try {
          if (job.msgRowId) {
            await supabase.from("messages").update({ status: "sending", error: null }).eq("id", job.msgRowId);
          }

          await sendViaUazapi(job.to, job.text);

          if (job.msgRowId) {
            await supabase
              .from("messages")
              .update({
                status: "sent",
                error: null,
                sent_at: new Date().toISOString(),
              })
              .eq("id", job.msgRowId);
          }
        } catch (e: unknown) {
          if (job.msgRowId) {
            await supabase
              .from("messages")
              .update({
                status: "error",
                error: getErrMsg(e),
              })
              .eq("id", job.msgRowId);
          }
        }
      }

      batch.inProgress = false;
    }
  } finally {
    store.processing = false;
  }
}

function createBatch(): Batch {
  const s = getStore();
  const id = ++s.lastId;
  const b: Batch = { id, createdAt: now(), jobs: [], inProgress: false };
  s.batches.set(id, b);
  return b;
}

/* ========= Construção das linhas + jobs ========= */
async function createRowsAndJobs(
  batchId: number,
  contacts: Contact[],
  textPool: string[],
  startAtMs?: number | null,
  cadenceDays?: number[] | null,
  listaId?: number | null,
  listaNome?: string | null
) {
  const startBase = typeof startAtMs === "number" && startAtMs > 0 ? startAtMs : now();
  const cadence = Array.isArray(cadenceDays) ? cadenceDays : [];

  const rows: MessageRowInsert[] = [];
  const jobs: Job[] = [];

  for (const c of contacts) {
    const numero = norm(c.numero);
    if (!numero) continue;

    const moments = [startBase, ...cadence.map((d) => startBase + d * 86400000)];
    for (const when of moments) {
      for (const t of textPool) {
        const text = (t || "")
          .replaceAll("{{nome}}", String(c.nome || ""))
          .replaceAll("{{numero}}", String(c.numero || ""));

        rows.push({
          batch_id: batchId,
          lista_id: listaId ?? null,
          lista_nome: listaNome ?? null,
          numero,
          status: "queued",
          error: null,
          payload: { text },
          created_at: new Date().toISOString(),
          scheduled_at: new Date(when).toISOString(),
        });

        jobs.push({ to: numero, text, batchId, msgRowId: null, scheduledAt: when });
      }
    }
  }

  if (!rows.length) return { inserted: [] as { id: number }[], jobs: [] as Job[] };

  const insertRes = await supabase.from("messages").insert(rows).select("id");
  const insertData = (insertRes.data as Array<{ id: number }> | null) ?? null;
  const insertErr = insertRes.error as { message?: string } | null;

  if (insertErr) throw new Error(insertErr.message ?? "Falha ao inserir mensagens");

  let i = 0;
  for (const j of jobs) j.msgRowId = insertData?.[i++].id ?? null;

  return { inserted: insertData || [], jobs };
}

/* ========= GET (status do batch) ========= */
export async function GET(req: NextRequest) {
  const batchId = Number(req.nextUrl.searchParams.get("batchId") || 0);
  if (!batchId) return NextResponse.json({ error: "missing batchId" }, { status: 400 });

  const sel = await supabase.from("messages").select("status, error").eq("batch_id", batchId);

  const data = (sel.data as MessageRowSelect[] | null) ?? [];
  const sent = data.filter((r) => r.status === "sent").length;
  const failed = data.filter((r) => r.status === "error").length;
  const queued = data.filter((r) => r.status === "queued" || r.status === "sending").length;

  return NextResponse.json({
    ok: true,
    batchId,
    sent,
    failed,
    queued,
    inProgress: queued > 0,
    errors: data.filter((r) => !!r.error).slice(-10),
  });
}

/* ========= POST (cria batch, agenda e dispara worker) ========= */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as unknown;

    // Narrowing seguro do corpo:
    const {
      listaId = null,
      listaNome = null,
      textPool = [],
      contacts = [],
      cadenceDays = [],
      delayMsMin = 1000,
      delayMsMax = 5000,
      pauseEvery = 0,
      pauseDurationMs = 0,
    } = (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}) as {
      listaId?: number | null;
      listaNome?: string | null;
      textPool?: string[];
      contacts?: Contact[];
      cadenceDays?: number[];
      delayMsMin?: number;
      delayMsMax?: number;
      pauseEvery?: number;
      pauseDurationMs?: number;
    };

    if (!API_BASE || !TOKEN_INSTANCIA)
      return NextResponse.json({ ok: false, error: "config_missing" }, { status: 500 });

    if (!Array.isArray(textPool) || textPool.map((s) => String(s || "").trim()).filter(Boolean).length === 0)
      return NextResponse.json({ ok: false, error: "empty_templates" }, { status: 400 });

    if (!Array.isArray(contacts) || contacts.length === 0)
      return NextResponse.json({ ok: false, error: "empty_contacts" }, { status: 400 });

    // Se fora do horário, dispara a partir de 08:00 do próximo dia útil
    let startAt = now();
    if (!dentroHorario()) startAt = proxDiaUtil0800().getTime();

    const batch = createBatch();

    // cria linhas + jobs base (sem jitter/pausas)
    const { jobs } = await createRowsAndJobs(
      batch.id,
      contacts,
      textPool.map((s: string) => String(s || "").trim()).filter(Boolean),
      startAt,
      cadenceDays,
      listaId,
      listaNome
    );

    if (jobs.length === 0) return NextResponse.json({ ok: false, error: "no_valid_numbers" }, { status: 400 });

    // aplica jitter/pausas
    const min = Math.max(0, Math.min(delayMsMin, delayMsMax));
    const max = Math.max(delayMsMin, delayMsMax);
    const sorted = jobs.sort((a, b) => a.scheduledAt - b.scheduledAt);

    let cursor = Math.max(now(), sorted[0].scheduledAt);
    let sincePause = 0;

    for (const j of sorted) {
      const gap = rand(min, max);
      cursor += gap;
      j.scheduledAt = cursor;
      sincePause++;
      if (pauseEvery > 0 && sincePause % pauseEvery === 0) {
        cursor += Math.max(0, pauseDurationMs);
      }
    }

    // persiste scheduled_at ajustado
    for (const j of sorted) {
      if (j.msgRowId) {
        await supabase
          .from("messages")
          .update({ scheduled_at: new Date(j.scheduledAt).toISOString() })
          .eq("id", j.msgRowId);
      }
    }

    // empilha e roda worker
    batch.jobs.push(...sorted);
    // fire-and-forget sem eslint-disable:
    void processBatches();

    return NextResponse.json({
      ok: true,
      batchId: batch.id,
      queued: batch.jobs.length,
      firstAt: new Date(sorted[0].scheduledAt).toISOString(),
      lastAt: new Date(sorted.at(-1)!.scheduledAt).toISOString(),
    });
  } catch (e: unknown) {
    console.error("[disparos:POST:error]", e);
    return NextResponse.json({ ok: false, error: getErrMsg(e) }, { status: 500 });
  }
}

// Netlify Function (v2 format) — calls Claude's vision API server-side so the API key
// never reaches the browser. Deployed at /.netlify/functions/recognize-floorplan
// (also reachable at /api/recognize-floorplan via config.path below).
// NOTE: uses .mjs extension deliberately — Netlify's Node runtime needs an unambiguous
// ES Module signal for v2 functions (export default + top-level export), and a plain
// .js file can sometimes be treated as CommonJS and fail to load correctly.

const SYSTEM_PROMPT = `你是專業的室內平面圖判讀助手。你會收到一張室內平面配置圖（可能是手繪丈量圖、建商平面圖、或設計平面圖）。

請仔細判讀圖中的每一個房間／空間，並且只回傳一個 JSON 物件，不要有任何其他文字、不要用 markdown code fence 包起來。

JSON 格式如下：
{
  "rooms": [
    { "name": "客廳", "polygon": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] }
  ],
  "notes": "任何你判讀時不確定或需要人工確認的地方"
}

規則：
- polygon 的每個座標都用「相對比例」表示，範圍是 0 到 1（0,0 是圖片左上角，1,1 是圖片右下角），不要用實際像素或公分
- 每個房間的 polygon 至少要有 3 個點，依照房間邊界（含牆的中心線即可，不用太精確）依順時針或逆時針列出
- name 請用繁體中文，盡量對應到常見房型名稱，例如：玄關、客廳、餐廳、廚房、主臥、次臥、書房、主浴、客浴、儲藏室、陽台、走道
- 如果同一種房型有多個（例如兩間次臥），請分別命名為「次臥A」「次臥B」
- 只辨識看得到完整邊界的空間，不確定的地方寧可放進 notes 說明，不要亂猜造成錯誤的 polygon
- 不要辨識牆、門、窗的細節，只要房間的整體邊界範圍`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "伺服器尚未設定 ANTHROPIC_API_KEY，請至 Netlify 後台 Site settings → Environment variables 新增。" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "請求格式錯誤，需要 JSON body。" }), { status: 400 });
  }

  const { imageBase64, mediaType } = body || {};
  if (!imageBase64 || !mediaType) {
    return new Response(JSON.stringify({ error: "缺少 imageBase64 或 mediaType。" }), { status: 400 });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: "請判讀這張平面圖，回傳 JSON。" },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Claude API 呼叫失敗（${response.status}）：${errText}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return new Response(JSON.stringify({ error: "AI 回應中沒有文字內容。" }), { status: 502 });
    }

    let parsed;
    try {
      // Claude may still wrap the JSON in a code fence despite instructions — strip if present.
      const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch (e) {
      return new Response(JSON.stringify({ error: "無法解析 AI 回傳的 JSON。", raw: textBlock.text }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(parsed.rooms)) {
      return new Response(JSON.stringify({ error: "AI 回傳格式不正確，缺少 rooms 陣列。", raw: parsed }), { status: 502 });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `伺服器錯誤：${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/recognize-floorplan",
};

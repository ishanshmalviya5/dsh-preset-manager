// Local mock of the Anthropic Messages API, scripted to attempt tools. Usage:
//   node mock-llm.mjs <portFile> <logFile> <script.json>
// script: [{tool, input}, ...] — one tool call per round trip, then a final text turn.
// Logs, per request: tool names offered, how many tool_results came back, and whether each was an error.
import http from 'node:http';
import fs from 'node:fs';

const [portFile, logFile, scriptFile] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of events) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not a messages call */ }
    if (!req.url.includes('/messages')) { res.writeHead(404); return res.end('{}'); }
    const results = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    const round = results.length;
    const entry = {
      url: req.url, round,
      tools: (body.tools ?? []).map((t) => t.name).sort(),
      toolSchemaBytes: JSON.stringify(body.tools ?? []).length,
      results: results.map((r) => ({ isError: r.is_error === true, text: JSON.stringify(r.content).slice(0, 160) })),
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    // MOCK_SCHEMAS_FILE: save the tool schemas the host sent (first request that has any), for benchmarks.
    if (process.env.MOCK_SCHEMAS_FILE && (body.tools ?? []).length && !fs.existsSync(process.env.MOCK_SCHEMAS_FILE)) fs.writeFileSync(process.env.MOCK_SCHEMAS_FILE, JSON.stringify(body.tools, null, 1));
    const step = script[round];
    const id = `msg_${round}`;
    const start = ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
    if (!step) {
      return sse(res, [start,
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }]]);
    }
    sse(res, [start,
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${round}`, name: step.tool, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }]]);
  });
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)); });

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

describe('Sequential Thinking SSE server', { timeout: 15000 }, () => {
  let child;
  let baseUrl;
  let errors = '';

  before(async () => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    baseUrl = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, ['dist/index.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PORT: String(port), DISABLE_THOUGHT_LOGGING: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let output = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 5000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code}: ${errors}`));
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('running on SSE')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  });

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  async function connect(t) {
    const client = new Client({ name: 'regression-client', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new SSEClientTransport(new URL(`${baseUrl}/sse`)), { timeout: 2000 });
    return client;
  }

  async function think(client, args) {
    const result = await client.callTool({ name: 'sequentialthinking', arguments: args }, undefined, { timeout: 2000 });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  }

  const initialThought = {
    thought: 'Check the available route options.',
    thoughtNumber: 1,
    totalThoughts: 2,
    nextThoughtNeeded: true
  };

  it('starts without duplicate port listeners', async (t) => {
    const client = await connect(t);
    await client.listTools();
    assert.doesNotMatch(errors, /EADDRINUSE/);
  });

  it('publishes the tool properties and required arguments', async (t) => {
    const client = await connect(t);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'sequentialthinking');
    const schema = tools[0].inputSchema;
    assert.equal(schema.properties.thought.type, 'string');
    assert.equal(schema.properties.thoughtNumber.type, 'integer');
    assert.equal(schema.properties.totalThoughts.type, 'integer');
    assert.deepEqual(schema.properties.nextThoughtNeeded.type, ['boolean', 'string']);
    assert.deepEqual(schema.required.sort(), ['nextThoughtNeeded', 'thought', 'thoughtNumber', 'totalThoughts']);
  });

  it('calls the tool and preserves thought history within a session', async (t) => {
    const client = await connect(t);
    const first = await think(client, initialThought);
    assert.equal(first.thoughtHistoryLength, 1);
    const second = await think(client, {
      ...initialThought, thoughtNumber: 2, nextThoughtNeeded: false,
      isRevision: true, revisesThought: 1, branchFromThought: 1, branchId: 'alternative'
    });
    assert.equal(second.thoughtHistoryLength, 2);
    assert.equal(second.nextThoughtNeeded, false);
    assert.deepEqual(second.branches, ['alternative']);
  });

  it('coerces string booleans and numbers without treating false as true', async (t) => {
    const client = await connect(t);
    const result = await think(client, {
      ...initialThought, thoughtNumber: '3', totalThoughts: '1',
      nextThoughtNeeded: 'false', isRevision: 'false', needsMoreThoughts: 'false'
    });
    assert.equal(result.thoughtNumber, 3);
    assert.equal(result.totalThoughts, 3);
    assert.equal(result.nextThoughtNeeded, false);
  });

  it('rejects missing or invalid arguments before processing a thought', async (t) => {
    const client = await connect(t);
    for (const args of [undefined, {}, { ...initialThought, nextThoughtNeeded: 'invalid' }, { ...initialThought, thoughtNumber: 0 }]) {
      await assert.rejects(client.callTool({ name: 'sequentialthinking', arguments: args }), { code: -32602 });
    }
    const result = await think(client, initialThought);
    assert.equal(result.thoughtHistoryLength, 1);
  });

  it('rejects unknown tools', async (t) => {
    const client = await connect(t);
    await assert.rejects(client.callTool({ name: 'unknown', arguments: {} }), { code: -32602 });
  });

  it('keeps concurrent clients connected with independent thought histories', async (t) => {
    const first = await connect(t);
    const second = await connect(t);
    assert.equal((await first.listTools(undefined, { timeout: 2000 })).tools.length, 1);
    assert.equal((await second.listTools(undefined, { timeout: 2000 })).tools.length, 1);
    assert.equal((await think(first, initialThought)).thoughtHistoryLength, 1);
    assert.equal((await think(first, { ...initialThought, thoughtNumber: 2 })).thoughtHistoryLength, 2);
    assert.equal((await think(second, initialThought)).thoughtHistoryLength, 1);
    await first.close();
    assert.equal((await think(second, { ...initialThought, thoughtNumber: 2 })).thoughtHistoryLength, 2);
  });

  it('rejects missing, unknown and repeated session IDs', async (t) => {
    const client = await connect(t);
    for (const query of ['', '?sessionId=unknown', '?sessionId=one&sessionId=two', '?sessionId=__proto__', '?sessionId=toString']) {
      const response = await fetch(`${baseUrl}/messages${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      });
      assert.equal(response.status, 400);
      await response.text();
    }
    assert.equal((await client.listTools()).tools.length, 1);
  });
});

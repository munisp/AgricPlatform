import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SftpFieldDataClient, SftpParseError, type SftpFieldDataConfig } from './field-data.clients.js';
import { ProviderRequestError } from './http.js';

/**
 * Unit tests for the SFTP pull transport with the ssh2 module mocked — no
 * live server. The fake Client replays scripted readdir/read streams and can
 * be told to fail the handshake.
 */
const ssh2State = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failHandshake: false,
  lastConnectConfig: undefined as Record<string, unknown> | undefined
}));

vi.mock('ssh2', () => {
  class FakeSftpWrapper {
    readdir(_dir: string, cb: (err: Error | undefined, list: { filename: string }[]) => void) {
      const list = [...ssh2State.files.keys()].map((filename) => ({ filename }));
      cb(undefined, list);
    }
    createReadStream(path: string) {
      const name = path.split('/').pop() as string;
      const content = ssh2State.files.get(name);
      if (content === undefined) {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => stream.emit('error', new Error('no such file')));
        return stream;
      }
      return Readable.from([Buffer.from(content)]);
    }
  }
  class FakeClient extends EventEmitter {
    connect(config: Record<string, unknown>) {
      ssh2State.lastConnectConfig = config;
      queueMicrotask(() => {
        if (ssh2State.failHandshake) {
          this.emit('error', new Error('connect timed out'));
        } else {
          this.emit('ready');
        }
      });
      return this;
    }
    sftp(cb: (err: Error | undefined, sftp: FakeSftpWrapper) => void) {
      cb(undefined, new FakeSftpWrapper());
    }
    end() {}
  }
  return { Client: FakeClient };
});

const CONFIG: SftpFieldDataConfig = {
  host: 'sftp.partner.example',
  port: 22,
  username: 'drop',
  privateKey: '-----BEGIN KEY-----\nfake\n-----END KEY-----',
  remoteDir: '/drop',
  connectTimeoutMs: 5000
};

function reset(): void {
  ssh2State.files.clear();
  ssh2State.failHandshake = false;
  ssh2State.lastConnectConfig = undefined;
}

describe('SftpFieldDataClient (mocked ssh2)', () => {
  it('connects with the configured host/credentials and 5s ready timeout', async () => {
    reset();
    ssh2State.files.set('batch-1.json', '[]');
    await new SftpFieldDataClient(CONFIG).fetchSubmissions();
    expect(ssh2State.lastConnectConfig).toMatchObject({
      host: 'sftp.partner.example',
      port: 22,
      username: 'drop',
      readyTimeout: 5000
    });
  });

  it('lists the drop directory, downloads *.json files and aggregates rows', async () => {
    reset();
    ssh2State.files.set('a.json', JSON.stringify([{ name: 'Amina', phone: '0801' }]));
    ssh2State.files.set(
      'b.json',
      JSON.stringify({ results: [{ name: 'Bala' }, { name: 'Chidi' }] })
    );
    // Non-JSON drops are ignored by the list filter.
    ssh2State.files.set('notes.txt', 'not a submission');
    // The .txt file must not be downloaded: give it content that would fail parsing.
    const rows = await new SftpFieldDataClient(CONFIG).fetchSubmissions();
    expect(rows).toEqual([{ name: 'Amina', phone: '0801' }, { name: 'Bala' }, { name: 'Chidi' }]);
  });

  it('accepts the ODK-style { value: [...] } envelope', async () => {
    reset();
    ssh2State.files.set('odk.json', JSON.stringify({ value: [{ nin: '123' }] }));
    const rows = await new SftpFieldDataClient(CONFIG).fetchSubmissions();
    expect(rows).toEqual([{ nin: '123' }]);
  });

  it('raises SftpParseError on invalid JSON drop files', async () => {
    reset();
    ssh2State.files.set('broken.json', '{not json');
    await expect(new SftpFieldDataClient(CONFIG).fetchSubmissions()).rejects.toThrow(
      SftpParseError
    );
  });

  it('raises SftpParseError on JSON documents with no submission rows', async () => {
    reset();
    ssh2State.files.set('shape.json', JSON.stringify({ unexpected: true }));
    await expect(new SftpFieldDataClient(CONFIG).fetchSubmissions()).rejects.toThrow(
      /not a parseable submission document/
    );
  });

  it('maps handshake failures to ProviderRequestError(network)', async () => {
    reset();
    ssh2State.failHandshake = true;
    await expect(new SftpFieldDataClient(CONFIG).fetchSubmissions()).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'network'
    });
    await expect(new SftpFieldDataClient(CONFIG).fetchSubmissions()).rejects.toThrow(
      ProviderRequestError
    );
  });
});

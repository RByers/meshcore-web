import { describe, expect, it } from 'vitest';
import { fromHex } from '../util/bytes.js';
import { PayloadType, RouteType } from './constants.js';
import { calcSharedSecret, ed25519KeyPairFromSeed } from './crypto.js';
import { buildPacket } from './packet.js';
import { buildAdvertPayload, buildDiscoverReqPayload, buildPeerDatagramPayload, buildReqPlaintext } from './payloads.js';
import { annotatePacket, annotatePacketSync, annotatePayloadSync, type AnnotationNode } from './annotate.js';
import { describeNodes, PACKET_FIELD_DOCS, PACKET_VALUE_DOCS, packetTypeNameDescription } from './field-docs.js';

describe('packetTypeNameDescription', () => {
  it('describes route and payload types by name, without the name prefix or § references', () => {
    const tf = packetTypeNameDescription('TRANSPORT_FLOOD');
    expect(tf).toMatch(/^a flood scoped to a region\./);
    expect(tf).not.toContain('§');
    const req = packetTypeNameDescription('REQ');
    expect(req).toBeTruthy();
    expect(req).not.toMatch(/^REQ \(/);
    expect(req).not.toContain('§');
    expect(packetTypeNameDescription('FLOOD')).toMatch(/^an unscoped flood/);
  });

  it('is undefined for other strings', () => {
    expect(packetTypeNameDescription('UNKNOWN')).toBeUndefined();
    expect(packetTypeNameDescription('toString')).toBeUndefined();
    expect(packetTypeNameDescription('')).toBeUndefined();
  });
});

const a = await ed25519KeyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const b = await ed25519KeyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i));
const secretAB = await calcSharedSecret(a.privateKey, b.publicKey);

function find(n: AnnotationNode, name: string): AnnotationNode {
  const walk = (x: AnnotationNode): AnnotationNode | undefined => {
    if (x.name === name) return x;
    for (const c of x.children ?? []) {
      const f = walk(c);
      if (f) return f;
    }
    return undefined;
  };
  const f = walk(n);
  if (!f) throw new Error(`no node ${name}`);
  return f;
}

function raw(routeType: RouteType, path: Uint8Array = new Uint8Array(0)): Uint8Array {
  return buildPacket({ routeType, payloadType: PayloadType.RAW_CUSTOM, path, payload: fromHex('deadbeef') });
}

describe('value descriptions (PACKET_VALUE_DOCS)', () => {
  it('route type FLOOD explains flooding, not the other route types', () => {
    const rt = find(annotatePacketSync(raw(RouteType.FLOOD)), 'route type');
    expect(rt.valueDescription).toMatch(/^FLOOD \(1\)/);
    expect(rt.valueDescription).toContain('appending its own hash');
    expect(rt.valueDescription).not.toContain('DIRECT');
    // the field description stays general and lists every route type
    expect(rt.description).toContain('0 TRANSPORT_FLOOD');
    expect(rt.description).toContain('2 DIRECT');
  });

  it('route type DIRECT / TRANSPORT_FLOOD / TRANSPORT_DIRECT get their own text', () => {
    expect(find(annotatePacketSync(raw(RouteType.DIRECT)), 'route type').valueDescription).toMatch(/^DIRECT \(2\): source-routed/);
    expect(find(annotatePacketSync(raw(RouteType.TRANSPORT_FLOOD)), 'route type').valueDescription).toMatch(/^TRANSPORT_FLOOD \(0\)/);
    expect(find(annotatePacketSync(raw(RouteType.TRANSPORT_DIRECT)), 'route type').valueDescription).toMatch(/^TRANSPORT_DIRECT \(3\)/);
  });

  it('hop count depends on the route type', () => {
    expect(find(annotatePacketSync(raw(RouteType.FLOOD)), 'hop count').valueDescription).toMatch(/^0 hops: a fresh flood/);
    expect(find(annotatePacketSync(raw(RouteType.FLOOD, fromHex('a1b2'))), 'hop count').valueDescription).toMatch(/^2 hops: relayed by 2 repeaters/);
    expect(find(annotatePacketSync(raw(RouteType.DIRECT)), 'hop count').valueDescription).toMatch(/^0 hops: zero-hop/);
    expect(find(annotatePacketSync(raw(RouteType.DIRECT, fromHex('a1'))), 'hop count').valueDescription).toMatch(/^1 hop still to go/);
    expect(find(annotatePacketSync(raw(RouteType.FLOOD)), 'hash size').valueDescription).toMatch(/^1-byte hashes/);
  });

  it('payload type and version', () => {
    const ann = annotatePacketSync(raw(RouteType.DIRECT));
    expect(find(ann, 'payload type').valueDescription).toMatch(/^RAW_CUSTOM \(15\)/);
    expect(find(ann, 'payload type').description).toMatch(/^What the payload is: 0 REQ/);
    expect(find(ann, 'payload version').valueDescription).toMatch(/^v1 \(0\)/);
    const reserved = annotatePacketSync(buildPacket({ routeType: RouteType.FLOOD, payloadType: 13, payload: fromHex('01') }));
    expect(find(reserved, 'payload type').valueDescription).toMatch(/^13: a reserved payload type/);
  });

  it('ADVERT node type and flag bits', async () => {
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.ADVERT,
      payload: await buildAdvertPayload({ keys: a, timestamp: 1700000000, appData: { nodeType: 2, name: 'Repeater 1' } }),
    });
    const ann = annotatePacketSync(bytes);
    expect(find(ann, 'node type').valueDescription).toMatch(/^REPEATER \(2\)/);
    expect(find(ann, 'has name').valueDescription).toMatch(/^Set:/);
    expect(find(ann, 'has lat/lon').valueDescription).toMatch(/^Not set:/);
  });

  it('REQ req_type explains the specific request', async () => {
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.REQ,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildReqPlaintext(1700000000, 0x06, fromHex('0005000000000611223344')),
      }),
    });
    const ann = await annotatePacket(bytes, { keys: { sharedSecrets: [secretAB] } });
    const rt = find(ann, 'req_type');
    expect(rt.valueDescription).toMatch(/^GET_NEIGHBOURS \(6\)/);
    expect(rt.description).toMatch(/^Request type: 1 GET_STATUS/);
  });

  it('bare payloads get value docs too (CONTROL sub_type)', () => {
    const ann = annotatePayloadSync(PayloadType.CONTROL, buildDiscoverReqPayload({ typeFilter: 4, tag: 7, prefixOnly: true }));
    expect(find(ann, 'sub_type').valueDescription).toMatch(/^DISCOVER_REQ \(0x80\)/);
    expect(find(ann, 'prefix_only').valueDescription).toMatch(/^1: respondents send only an 8-byte prefix/);
  });

  it('does not overwrite an existing description or valueDescription', () => {
    const node: AnnotationNode = {
      offset: 0,
      length: 1,
      name: 'header',
      value: '0x05',
      children: [{ offset: 0, length: 1, name: 'route type', value: '1', bits: { mask: 3 }, description: 'mine', valueDescription: 'my value' }],
    };
    describeNodes([node], 'env', PACKET_FIELD_DOCS, { values: PACKET_VALUE_DOCS });
    expect(node.children![0]!.description).toBe('mine');
    expect(node.children![0]!.valueDescription).toBe('my value');
    expect(node.description).toMatch(/^Header byte/);
  });

  it('without a value table no valueDescription is set', () => {
    const node: AnnotationNode = { offset: 0, length: 1, name: 'route type', value: '1' };
    describeNodes([{ offset: 0, length: 1, name: 'header', value: '0x05', children: [node] }], 'env', PACKET_FIELD_DOCS);
    expect(node.description).toBeDefined();
    expect(node.valueDescription).toBeUndefined();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { checkWellFormed } from './xml-wellformed.ts';

const ok = (xml: string) => assert.deepEqual(checkWellFormed(xml), { ok: true }, xml);
const bad = (xml: string, re: RegExp) => {
  const r = checkWellFormed(xml);
  assert.equal(r.ok, false, xml);
  assert.match((r as { error: string }).error, re);
};

describe('xml-wellformed', () => {
  it('accepts prolog, BOM, comments, CDATA, PI, namespaces, self-closing', () => {
    ok('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- top --><ns:a xmlns:ns="u"><b/><![CDATA[<x>&]]><?pi data?></ns:a>\n');
  });
  it('accepts ">" inside a quoted attribute value and predefined/char entities', () => {
    ok(`<a t="x > y" u='1'>&amp;&lt;&#65;&#x41;</a>`);
  });
  it('rejects overlapping tags', () => bad('<a><b></a></b>', /mismatched/));
  it('rejects unclosed root', () => bad('<a><b/>', /unclosed/));
  it('rejects multiple roots', () => bad('<a/><b/>', /multiple root/));
  it('rejects text outside root', () => bad('<a/>junk', /outside root/));
  it('rejects empty document', () => bad('  ', /no root/));
  it('rejects DOCTYPE', () => bad('<!DOCTYPE a><a/>', /DTD/));
  it('rejects unknown entity references', () => bad('<a>&e;</a>', /entity/));
  it('rejects duplicate and unquoted attributes', () => {
    bad('<a x="1" x="2"/>', /duplicate/);
    bad('<a x=1/>', /malformed attributes/);
  });
  it('rejects XML declaration not at start', () => bad('<a/><?xml version="1.0"?>', /declaration/));
});

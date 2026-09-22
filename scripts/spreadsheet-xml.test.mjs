import test from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { normalizeSpreadsheetXml } from '../src/spreadsheet-xml.ts';
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
function content(xml) {
  const events=[];const parser=new SaxesParser({xmlns:true});
  parser.on('opentag',tag=>events.push([tag.uri,tag.local,Object.values(tag.attributes).filter(a=>a.uri!=='http://www.w3.org/2000/xmlns/').map(a=>[a.uri,a.local,a.value])]));
  parser.on('text',text=>events.push(text));parser.on('cdata',text=>events.push(text));parser.write(xml).close();return events;
}
test('canonicalizes prefixed SpreadsheetML without changing namespace identity, values or foreign extensions',()=>{
  const xml=`<x:worksheet xmlns:x="${ns}" xmlns:r="urn:relationships"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t xml:space="preserve">  中文 &amp; &lt;x:tag&gt; </x:t></x:is></x:c></x:row></x:sheetData><extension xmlns="urn:foreign"><x:c r:id="a&amp;b" note="&#10;&#9;&#13;&quot;"/><c/><x:cell xmlns:x="urn:other"/></extension><!--x:c--><x:ext><![CDATA[<x:c>]]></x:ext></x:worksheet>`;
  const normalized=normalizeSpreadsheetXml(xml);
  assert.ok(normalized.startsWith('<worksheet '));assert.ok(normalized.includes('<sheetData>'));assert.deepEqual(content(normalized),content(xml));
});
test('leaves ordinary spreadsheets untouched and rejects malformed prefixed XML',()=>{
  const ordinary=`<worksheet xmlns="${ns}"><sheetData/></worksheet>`;
  assert.equal(normalizeSpreadsheetXml(ordinary),ordinary);
  assert.throws(()=>normalizeSpreadsheetXml(`<x:worksheet xmlns:x="${ns}"><x:row></x:worksheet>`));
});
test('resolves package-absolute table targets relative to their owning part, preserving external links',()=>{
  const xml='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="table" Target="/xl/tables/table1.xml"/><Relationship Id="relative" Target="../drawings/drawing1.xml"/><Relationship Id="external" Target="/external" TargetMode="External"/></Relationships>';
  const normalized=normalizeSpreadsheetXml(xml,'xl/worksheets/_rels/sheet1.xml.rels');
  assert.ok(normalized.includes('Target="../tables/table1.xml"'));
  assert.ok(normalized.includes('Target="../drawings/drawing1.xml"'));
  assert.ok(normalized.includes('Target="/external"'));
  assert.ok(normalizeSpreadsheetXml(xml,'_rels/.rels').includes('Target="xl/tables/table1.xml"'));
});
test('repairs empty rich-text runs and empty style colors in ordinary workbooks',()=>{
  const sharedStrings='<sst xmlns="'+ns+'"><si><t></t><r><t>link</t></r></si></sst>';
  const styles='<styleSheet xmlns="'+ns+'"><fills><fill><patternFill><fgColor></fgColor><bgColor></bgColor></patternFill></fill></fills></styleSheet>';
  assert.equal(normalizeSpreadsheetXml(sharedStrings,'xl/sharedStrings.xml'),'<sst xmlns="'+ns+'"><si><r><t>link</t></r></si></sst>');
  assert.equal(normalizeSpreadsheetXml(styles,'xl/styles.xml'),'<styleSheet xmlns="'+ns+'"><fills><fill><patternFill></patternFill></fill></fills></styleSheet>');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { photoPreviewPixelLimit, imageOverflowMode } from '../src/image-layout.ts';
test('photo decode budget uses physical monitor pixels and stays bounded',()=>{
  assert.equal(photoPreviewPixelLimit(1920,1080),1920);
  assert.equal(photoPreviewPixelLimit(2880,1800),2880);
  assert.equal(photoPreviewPixelLimit(1080,1920),1920);
  assert.equal(photoPreviewPixelLimit(7680,4320),4096);
  assert.equal(photoPreviewPixelLimit(320,240),512);
  assert.equal(photoPreviewPixelLimit(NaN,NaN),2048);
  assert.equal(photoPreviewPixelLimit(0,0),2048);
});
test('long and tiny images retain distinct scrolling behavior',()=>{
  assert.equal(imageOverflowMode(400,4000,1000,800),'scroll-y');
  assert.equal(imageOverflowMode(4000,300,1000,800),'scroll-x');
  assert.equal(imageOverflowMode(40,400,1000,800),'contain');
});

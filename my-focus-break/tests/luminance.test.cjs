const assert=require('node:assert/strict');
const {luminance}=require('../src/luminance');
for(let t=0;t<60000;t+=23)for(let layer=0;layer<4;layer++){
 const value=luminance(t,layer,true);assert.ok(value>=.30&&value<=.88001);
}
assert.equal(luminance(10000,0,false),.38);
assert.ok(luminance(5000,0,true)>luminance(5000,3,true));
assert.ok(Math.abs(luminance(6999,0,true)-luminance(7000,0,true))<.001);
const fs=require('node:fs');const source=fs.readFileSync(require('node:path').join(__dirname,'../src/index.js'),'utf8');
const paint=source.slice(source.indexOf('function paint()'),source.indexOf('function tick()'));
assert.ok(!/setPosition|setSize|setScale|setQuad/.test(paint));
console.log('PASS: brightness bounds, phase delay, wrap continuity, no geometry mutation in animation');

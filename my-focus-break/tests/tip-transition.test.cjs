const assert=require('node:assert/strict');
const {tipFrame}=require('../src/tip-transition');
assert.deepEqual(tipFrame('old','new',0),{text:'old',opacity:1});
assert.deepEqual(tipFrame('old','new',450),{text:'new',opacity:0});
assert.deepEqual(tipFrame('old','new',1100),{text:'new',opacity:1});
assert.equal(tipFrame('','new',0).opacity,0);
assert.equal(tipFrame('','new',650).opacity,1);
assert.ok(tipFrame('old','new',449).opacity<.0001);
assert.ok(tipFrame('old','new',451).opacity<.0001);
for(let t=0;t<8000;t+=17){const s=tipFrame('old','new',t);assert.ok(s.opacity>=0&&s.opacity<=1);assert.equal(s.text,t<450?'old':'new');}
console.log('PASS: tip text switches only at darkness, continuous fades and bounded brightness');

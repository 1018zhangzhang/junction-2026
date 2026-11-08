const assert=require('node:assert/strict');
const {sample}=require('../src/rhythm');
assert.equal(sample(0).phase,'ready');assert.equal(sample(2999).count,1);
assert.equal(sample(3000).phase,'inhale');assert.equal(sample(3000).scale,0);
assert.equal(sample(7000).phase,'exhale');assert.equal(sample(7000).scale,1);
assert.equal(sample(11000).cycle,2);assert.equal(sample(51000).phase,'rest');assert.equal(sample(59000).phase,'ready');
for(let t=0;t<120000;t+=17){const s=sample(t);assert.ok(s.scale>=0&&s.scale<=1);assert.ok(s.progress>=0&&s.progress<=1);assert.ok(s.count>=1);}
assert.ok(Math.abs(sample(6999).scale-sample(7000).scale)<0.001);
console.log('PASS: phase boundaries, cycle wrap, smooth transition, bounded scale and progress');

"use strict";
// All dots remain fixed. Delayed brightness envelopes create the ripple.
function luminance(elapsed,layer,active,readyMs=3000) {
  if(!active)return 0.38;
  const seconds=Math.max(0,elapsed-readyMs)/1000;
  const phase=((seconds-layer*0.55)%4+4)%4/4;
  const pulse=Math.pow(Math.sin(Math.PI*phase),2);
  return 0.30+0.58*pulse;
}
module.exports={luminance};

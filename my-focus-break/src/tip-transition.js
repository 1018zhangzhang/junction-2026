"use strict";
const OUT_MS=450,IN_MS=650;
function smooth(t){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);}
// Fade through black. Replace the copy only at zero brightness.
function tipFrame(from,to,age){
 age=Math.max(0,age);
 if(!from)return {text:to,opacity:smooth(age/IN_MS)};
 if(age<OUT_MS)return {text:from,opacity:1-smooth(age/OUT_MS)};
 return {text:to,opacity:smooth((age-OUT_MS)/IN_MS)};
}
module.exports={tipFrame,OUT_MS,IN_MS};

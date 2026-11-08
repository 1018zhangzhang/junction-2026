"use strict";
const SETTINGS = Object.freeze({readyMs:3000, inhaleMs:4000, exhaleMs:4000, cycles:6, restMs:8000});
function sample(elapsed, config=SETTINGS) {
  const cycleMs=config.inhaleMs+config.exhaleMs;
  const total=config.readyMs+cycleMs*config.cycles+config.restMs;
  const t=Math.max(0,elapsed)%total;
  if(t<config.readyMs) return {phase:'ready',label:'准备',hint:'跟随方框 · 自然呼吸',count:Math.ceil((config.readyMs-t)/1000),scale:0,cycle:0,progress:0};
  const work=t-config.readyMs;
  if(work>=cycleMs*config.cycles) return {phase:'rest',label:'完成',hint:'放松片刻 · 即将开始下一轮',count:Math.ceil((total-t)/1000),scale:0,cycle:config.cycles,progress:1};
  const position=work%cycleMs, inhale=position<config.inhaleMs;
  const fraction=inhale?position/config.inhaleMs:(position-config.inhaleMs)/config.exhaleMs;
  const eased=(1-Math.cos(Math.PI*fraction))/2;
  return {phase:inhale?'inhale':'exhale',label:inhale?'吸气':'呼气',hint:inhale?'让方框缓缓展开':'跟随方框慢慢收拢',count:Math.ceil((inhale?config.inhaleMs-position:cycleMs-position)/1000),scale:inhale?eased:1-eased,cycle:Math.floor(work/cycleMs)+1,progress:work/(cycleMs*config.cycles)};
}
module.exports={SETTINGS,sample};

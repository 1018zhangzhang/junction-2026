"use strict";
const os=require('@irisview/osx/os');
const ui=require('@irisview/osx/fusionui');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {SETTINGS,sample}=require('./rhythm');
const {luminance}=require('./luminance');
const {tipFrame}=require('./tip-transition');
// Keep strong references to native-backed widgets for the life of the window.
const view={};
// Original microcopy inspired by brief mindfulness prompts; one tip per full breath.
const TIPS=Object.freeze(['我跑通了|不要怀疑','静静感受|啥时睡觉','自然呼吸|不必用力','让思绪|轻轻经过','把注意|带回呼吸','给自己|一点时间']);
let frame=null,active=false,elapsed=0,lastTime=0,lastPaint=-Infinity,lastLabel='',lastPhase='';
function rect(parent,x,y,w,h,brightness,isCanvas=false) {
  const b=isCanvas?ui.Board.create():ui.View.create();b.setParent(parent);b.setIgnoreLayout(true);
  b.setPosition([x,y,0]);b.setSize([w,h,0]);
  b.getLocalStyle().setBackgroundColor(ui.Color.fromRGB8(0,brightness,0));
  return b;
}
function label(parent,y,height,size,brightness,text) {
  const t=ui.Text.create();t.setParent(parent);t.setIgnoreLayout(true);
  t.setPosition([0,y,0]);t.setSize([640,height,0]);
  const s=t.getLocalStyle();s.setTextColor(ui.Color.fromRGB8(0,brightness,0));s.setTextAlign(ui.TextAlign.CENTER);
  const font=ui.Font.getCachedFont('',size,0,0);if(font)s.setTextFont(font);
  t.setText(text);return t;
}
function ring(asset) {
  const image=ui.Image.create();image.setParent(view.canvas);image.setIgnoreLayout(true);
  image.onDataCompletion.add((code)=>console.log('RIPPLE_ASSET '+JSON.stringify({asset,code})));
  image.setSource(path.join(__dirname,'assets',asset));return image;
}
function paint() {
  const state=sample(elapsed),running=state.phase==='inhale'||state.phase==='exhale';
  // Geometry is immutable after start(); update brightness only.
  view.field.forEach((image,i)=>{
    const value=Math.round(luminance(elapsed,i,running,SETTINGS.readyMs)*32)/32;
    if(view.levels[i]!==value){image.getLocalStyle().setImageOpacity(value);view.levels[i]=value;}
  });
  const tip=state.phase==='ready'?'调整姿势|舒适就好':state.phase==='rest'?'带着平静|回到当下':TIPS[(state.cycle-1)%TIPS.length];
  if(tip!==view.tipTarget){
    view.tipFrom=view.tipVisible||'';view.tipTarget=tip;view.tipStart=elapsed;
  }
  const tipState=tipFrame(view.tipFrom,view.tipTarget,elapsed-view.tipStart);
  if(tipState.text!==view.tipVisible){
    const lines=tipState.text.split('|');
    view.hints.forEach((t,i)=>t.setText(lines[i]||''));view.tipVisible=tipState.text;
  }
  const brightness=Math.round(220*tipState.opacity);
  if(brightness!==view.tipBrightness){
    view.hints.forEach(t=>t.getLocalStyle().setTextColor(ui.Color.fromRGB8(0,brightness,0)));
    view.tipBrightness=brightness;
  }
  const key=state.phase+state.cycle;
  if(key!==lastLabel) {
    view.phase.setText(state.label);

    view.status.setText(state.phase==='rest'?'本轮完成':state.phase==='ready'?`${SETTINGS.cycles} 次舒缓循环`:`${state.cycle} / ${SETTINGS.cycles}`);
    view.dots.forEach((dot,i)=>dot.getLocalStyle().setBackgroundColor(ui.Color.fromRGB8(0,state.phase==='rest'?170:i===state.cycle-1?230:i<state.cycle-1?110:40,0)));
    lastLabel=key;
  }
  if(key!==lastPhase){console.log('BREATHE '+JSON.stringify({phase:state.phase,cycle:state.cycle,elapsed:Math.round(elapsed)}));lastPhase=key;}
}
function tick() {
  frame=null;if(!active || !view.window)return;
  const now=performance.now();elapsed+=Math.max(0,now-lastTime);lastTime=now;
  if(now-lastPaint>=50){paint();lastPaint=now;} // 20 Hz brightness; text only changes with phase or cycle.
  frame=os.requestAnimationFrame(tick);
}
function resume(){if(!view.window || active)return;active=true;lastTime=performance.now();frame=os.requestAnimationFrame(tick);}
function pause(){active=false;if(frame!==null)os.cancelAnimationFrame(frame);frame=null;}
function start(){
  if(view.window)return;
  elapsed = 0;
  lastPaint = -Infinity;
  lastLabel = '';
  lastPhase = '';
  const p=os.WindowProperty.create();p.setTitle('专注休息');p.setSize([0.64,0.48,0.01]);

  view.window=os.Window.create(p);view.root=ui.FusionRoot.acquireFusionRootFromWindow(view.window);
  view.canvas=rect(view.root.getRootWidget(),0,0,640,480,0,true);
          view.levels=[];
  view.field=Array.from({length:3},(_,i)=>{
    const image=ring('dots-'+i+'.png');
    image.setPosition([152,67,0]);image.setSize([336,336,0]);return image;
  });
  view.phase=label(view.canvas,188,44,30,240,'准备');
  view.hints=[label(view.canvas,238,30,22,0,''),label(view.canvas,267,30,22,0,'')];
  view.dots=Array.from({length:SETTINGS.cycles},(_,i)=>rect(view.canvas,317+(i-(SETTINGS.cycles-1)/2)*20,415,6,6,40));
    view.footer=label(view.canvas,455,28,14,160,'· 今天也很棒 ·');

  view.status=label(view.canvas,437,26,14,130,'');
  paint();resume();
}
os.App.createApp(event=>{
  console.log('BREATHE_LIFECYCLE '+event);
  if(event===os.AppLifecycle.ON_CREATE)start();
  else if(event===os.AppLifecycle.ON_FOREGROUND || event===os.AppLifecycle.ON_REOPEN)resume();
  else if(event===os.AppLifecycle.ON_BACKGROUND)pause();
  else if(event===os.AppLifecycle.ON_DESTROY){pause();for(const key of Object.keys(view))delete view[key];}
});

# -*- coding: utf-8 -*-
# ============================================================================
# 本地 Vosk 语音识别服务（把队友的 voice_test.py 改造成 HTTP 服务）
# ----------------------------------------------------------------------------
# 用法：POST /asr，multipart 字段 file = 一句话的 WAV(16kHz 单声道)
# 返回：{"text": "识别出的文字"}
# 输入来自 cook-frame 应用的 asr.js（VAD 切好的整句音频）
# 语法词表 = 队友原版 + 做饭引擎全部指令词（上一步/停/暂停/齁咸/还没好…）
# ============================================================================

import json
import os

from flask import Flask, jsonify, request
from vosk import KaldiRecognizer, Model

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE, "vosk-model-small-cn-0.22")
EXTRA_VOCAB_PATH = os.path.join(BASE, "extra_vocab.txt")


def load_extra_vocab():
    """重点词补丁文件：extra_vocab.txt，一行一个词，# 开头是注释。
    每次开识别流时重读 → 队友/我们改完立刻生效，不用重启服务、不用改本文件。
    这样多人同时加词也不会互相冲突（各写各的行）。"""
    words = []
    try:
        with open(EXTRA_VOCAB_PATH, encoding="utf-8") as handle:
            for line in handle:
                word = line.strip()
                if word and not word.startswith("#"):
                    words.append(word)
    except FileNotFoundError:
        pass
    except Exception as error:
        print("读取 extra_vocab.txt 失败：", error)
    return words


def grammar_with_extra(vocab=None):
    """最终词表 = 应用推来的词（可为空）+ extra_vocab.txt + 内置词表，去重保序。"""
    words = list(dict.fromkeys(
        [str(w) for w in (vocab or []) if w] + load_extra_vocab() + json.loads(GRAMMAR)))
    return json.dumps(words, ensure_ascii=False)


def known_words(vocab=None):
    """当前所有"认得"的词（用于给两种识别结果打分）。"""
    return list(dict.fromkeys(
        [str(w) for w in (vocab or []) if w] + load_extra_vocab() + json.loads(GRAMMAR)))


def dedupe(text):
    """去掉「同一句被重复堆叠」：下一步下一步 → 下一步（2/3 次重复都还原）"""
    t = (text or "").replace(" ", "")
    n = len(t)
    for k in (2, 3):
        if n >= 2 * k and n % k == 0:
            part = t[: n // k]
            if part and part * k == t:
                return part
    return t


def score_text(text, words):
    """给识别结果打分：命中词表的字数 - 没命中的字数×2。
    用来在「词表模式」和「自由模式」两个结果里挑更靠谱的那个。"""
    t = (text or "").replace(" ", "")
    if not t:
        return -9999
    covered = 0
    i = 0
    while i < len(t):
        best = None
        for w in words:
            if w and t.startswith(w, i) and (best is None or len(w) > len(best)):
                best = w
        if best:
            covered += len(best)
            i += len(best)
        else:
            i += 1
    return covered - (len(t) - covered) * 2

# 语法词表：限定识别范围，小模型准确率会显著提升
# 前 18 个词来自队友 voice_test.py 原版，其后是做饭引擎的指令与问答词
GRAMMAR = json.dumps([
    "番茄", "鸡蛋", "炒蛋", "可乐", "鸡翅", "黄瓜", "凉拌",
    "下一步", "继续", "好了", "放", "盐", "多少", "糖", "切",
    "火", "收汁", "冷藏",
    "上一步", "停", "停下", "暂停", "停止", "等一下", "等等",
    "还没好", "完成", "完成了", "结束", "开饭", "做好",
    "齁咸", "咸", "太咸", "淡", "太淡", "半勺", "一勺", "几分",
    "去皮", "皮", "蛋壳", "打散", "几个", "几个蛋", "油", "葱花",
    "蒜", "锅", "开火", "关火", "出锅", "装盘", "翻炒", "搅拌",
    "尝", "怎么样", "什么", "为什么", "怎么办", "我", "想", "做",
    "我想做", "来一个", "一份",
    "可乐鸡翅", "拍黄瓜", "凉拌黄瓜", "蒜末", "拍蒜", "香醋", "香油",
    "生抽", "老抽", "料酒", "姜片", "焯水", "血沫", "金黄", "芝麻",
    "白芝麻", "白糖", "腌", "杀水", "冷藏", "爽口", "上色", "焖",
    "推荐", "随便", "换菜", "换个菜", "重新选", "菜单", "选菜", "做什么菜"
], ensure_ascii=False)

app = Flask(__name__)

print("正在加载 Vosk 模型（约 5 秒）…")
model = Model(MODEL_PATH)
print("模型加载完成，识别服务就绪。")


@app.route("/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True, "model": os.path.basename(MODEL_PATH)})


def run_once(wav, grammar_json):
    """跑一遍识别。grammar_json 为词表 JSON 字符串=限定词表，None=全模式。返回去空格文本。"""
    rec = KaldiRecognizer(model, 16000)
    if grammar_json:
        try:
            rec.SetWords(False)
            rec.SetGrammar(grammar_json)
        except Exception as error:
            print("语法词表设置失败（本遍用全模式）：", error)
    try:
        if rec.AcceptWaveform(wav):
            text = json.loads(rec.Result()).get("text", "")
        else:
            text = json.loads(rec.FinalResult()).get("text", "")
    except Exception as error:
        print("识别出错：", error)
        return ""
    return text.strip()


@app.route("/asr", methods=["POST"])
def asr():
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"text": ""}), 400

    wav = uploaded.read()
    # 太短的声音（<约 0.1 秒）多半是误触发，直接空手而归
    if len(wav) < 2000:
        return jsonify({"text": ""})

    # 应用可以随句子推词表（当前菜谱的词），没推就用默认词表
    vocab = None
    raw_vocab = request.form.get("vocab")
    if raw_vocab:
        try:
            vocab = json.loads(raw_vocab)
        except Exception:
            vocab = None

    # 两种认法各跑一遍，谁更靠谱用谁：
    #   ① 词表模式：限定在当前菜谱/指令词里 → 短口令很准，但硬凑词，容易吐出怪句子
    #   ② 自由模式：不限定 → 说话自然时更接近原话，偶尔同音字
    cand_grammar = dedupe(run_once(wav, grammar_with_extra(vocab)))
    cand_free = dedupe(run_once(wav, None))
    words = known_words(vocab)
    s_g = score_text(cand_grammar, words)
    s_f = score_text(cand_free, words)
    if s_g >= s_f:
        text, mode = cand_grammar, "词表"
    else:
        text, mode = cand_free, "自由"

    print("🎤 识别结果[" + mode + "]:", text if text else "(空)",
          "| 候选 词表=" + repr(cand_grammar), "自由=" + repr(cand_free))
    return jsonify({"text": text})


# ============================================================================
# 流式识别：应用把 16kHz 单声道 PCM 以小块持续喂进来，实时返回部分结果
#   POST /stream/open          → {"id": "..."}
#   POST /stream/<id>  原始PCM → {"partial": "当前识别到一半的文字"}
#   POST /stream/<id>/end      → {"text": "最终整句文字"}（并销毁会话）
# 同一个流跨多个平台录音会话保持上下文 —— 平台中途切一刀也不会打断句子。
# ============================================================================
import time
import uuid

STREAMS = {}          # id -> {"rec": 识别器, "segments": [完整段], "last": 时间戳}
STREAM_TTL = 120      # 流空闲回收（秒）


def _new_stream(vocab=None):
    rec = KaldiRecognizer(model, 16000)
    try:
        rec.SetWords(False)
        rec.SetGrammar(grammar_with_extra(vocab))
    except Exception as error:
        print("流式语法词表设置失败（全模式）：", error)
    return {"rec": rec, "segments": [], "last": time.time()}


def _cleanup_streams():
    now = time.time()
    for sid in [s for s, v in STREAMS.items() if now - v["last"] > STREAM_TTL]:
        STREAMS.pop(sid, None)
        print("🧹 回收超时识别流", sid)


@app.route("/stream/open", methods=["POST"])
def stream_open():
    _cleanup_streams()
    # 应用可以带 JSON body 推词表：{"vocab": ["可乐鸡翅", "鸡翅", ...]}
    data = request.get_json(silent=True) or {}
    vocab = data.get("vocab") if isinstance(data, dict) else None
    sid = uuid.uuid4().hex[:12]
    STREAMS[sid] = _new_stream(vocab)
    print("🎙️ 新识别流", sid, "| 词表:", ("应用推送 " + str(len(vocab)) + " 词") if vocab else "默认")
    return jsonify({"id": sid})


@app.route("/stream/<sid>", methods=["POST"])
def stream_feed(sid):
    stream = STREAMS.get(sid)
    if stream is None:
        return jsonify({"error": "no such stream"}), 404
    pcm = request.get_data()
    stream["last"] = time.time()
    if pcm and len(pcm) >= 2:
        try:
            if stream["rec"].AcceptWaveform(pcm):
                seg = json.loads(stream["rec"].Result()).get("text", "")
                if seg:
                    stream["segments"].append(seg)
        except Exception as error:
            print("流式识别出错：", error)
            return jsonify({"error": str(error)}), 500
    partial = json.loads(stream["rec"].PartialResult()).get("partial", "")
    text = dedupe("".join(stream["segments"]) + partial)
    return jsonify({"partial": text})


@app.route("/stream/<sid>/end", methods=["POST"])
def stream_end(sid):
    stream = STREAMS.pop(sid, None)
    if stream is None:
        return jsonify({"text": ""})
    try:
        final = json.loads(stream["rec"].FinalResult()).get("text", "")
    except Exception as error:
        print("流式收尾出错：", error)
        final = ""
    text = dedupe("".join(stream["segments"]) + final)
    print("🎤 流式最终结果:", text if text else "(空)")
    return jsonify({"text": text})


if __name__ == "__main__":
    # 0.0.0.0：WSL 和 Windows 两边都能访问到本服务
    app.run(host="0.0.0.0", port=5001, threaded=True)

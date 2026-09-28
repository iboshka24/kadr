"""Мост к бесплатному голосу Microsoft Edge.

Ключ не нужен, платить не нужно, но есть две вещи, которые надо сделать самому,
иначе на длинном видео всё падает:

1. Тайминги слов надо просить явно (`boundary="WordBoundary"`) — без этого
   сервис отдаёт только звук, и субтитры потом нечем посадить на речь.
2. Длинный текст сервис молча не озвучивает: на сценарии целиком он отвечает
   `NoAudioReceived`. Поэтому текст режется на куски по границам предложений,
   каждый озвучивается отдельно, звук склеивается, а тайминги сдвигаются на
   длительность уже озвученного.

На выходе — один mp3 и один JSON со словами и миллисекундами от начала файла.
"""
import argparse
import asyncio
import json
import pathlib
import re

import edge_tts

MAX_CHARS = 700  # на таких кусках сервис отвечает надёжно


def split_text(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    """Режет текст по границам предложений, не разрывая их."""
    sentences = re.split(r"(?<=[.!?…])\s+", text.strip())
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 <= max_chars:
            current = f"{current} {sentence}".strip()
        else:
            if current:
                chunks.append(current)
            # Предложение длиннее лимита — режем по запятым, иначе по пробелам.
            while len(sentence) > max_chars:
                cut = sentence.rfind(",", 0, max_chars)
                if cut < max_chars // 2:
                    cut = sentence.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                chunks.append(sentence[: cut + 1].strip())
                sentence = sentence[cut + 1 :].strip()
            current = sentence
    if current:
        chunks.append(current)
    return chunks


async def try_voice(voice: str, rate: str, probe_text: str = "Проверка связи.") -> bool:
    """Отвечает ли этот голос прямо сейчас.

    Голоса у бесплатного сервиса живут своей жизнью: `ru-RU-DmitryNeural` в один
    день перестаёт отдавать звук и отвечает `NoAudioReceived` даже на короткую
    фразу, а через день работает снова. Падать из-за этого конвейер не должен —
    голос проверяется короткой пробой, и берётся первый живой.
    """
    try:
        comm = edge_tts.Communicate(probe_text, voice, rate=rate, boundary="WordBoundary")
        audio = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
        return len(audio) > 0
    except Exception:
        return False


async def pick_voice(candidates: list[str], rate: str) -> str:
    for voice in candidates:
        if not voice:
            continue
        if await try_voice(voice, rate):
            return voice
    raise SystemExit("ни один голос не отвечает: " + ", ".join(candidates))


async def synth_chunk(text: str, voice: str, rate: str) -> tuple[bytes, list[dict]]:
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    audio = bytearray()
    words: list[dict] = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append(
                {
                    "word": chunk["text"],
                    "startMs": round(chunk["offset"] / 10_000),
                    "durMs": round(chunk["duration"] / 10_000),
                }
            )
    return bytes(audio), words


async def synth(
    text: str,
    voice: str,
    rate: str,
    out_mp3: pathlib.Path,
    out_json: pathlib.Path,
    fallbacks: list[str] | None = None,
) -> None:
    chunks = split_text(text)
    if not chunks:
        raise SystemExit("текст пуст")

    # Сначала убеждаемся, что голос живой: иначе первый же кусок упадёт и стадия
    # озвучки сгорит целиком на ровном месте.
    chosen = await pick_voice([voice, *(fallbacks or [])], rate)
    if chosen != voice:
        print(json.dumps({"voiceFallback": True, "requested": voice, "chosen": chosen}), flush=True)
    voice = chosen

    audio = bytearray()
    words: list[dict] = []
    offset_ms = 0

    for index, chunk in enumerate(chunks, start=1):
        piece, piece_words = await synth_chunk(chunk, voice, rate)
        if not piece:
            raise SystemExit(f"кусок {index} вернулся без звука: «{chunk[:60]}…»")

        audio.extend(piece)

        # Тайминги куска считаются от его начала — сдвигаем на всё, что уже
        # озвучено, иначе субтитры второго куска начинались бы с нуля.
        shifted = [
            {"word": w["word"], "startMs": w["startMs"] + offset_ms, "durMs": w["durMs"]}
            for w in piece_words
        ]
        words.extend(shifted)
        offset_ms = (shifted[-1]["startMs"] + shifted[-1]["durMs"]) if shifted else offset_ms
        # Короткая пауза между кусками: без неё последняя фраза наезжает на первую.
        offset_ms += 260

    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_mp3.write_bytes(bytes(audio))

    out_json.write_text(
        json.dumps(
            {"words": words, "durationMs": offset_ms, "voice": voice, "rate": rate, "chunks": len(chunks)},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "bytes": len(audio),
                "words": len(words),
                "chunks": len(chunks),
                "durationMs": offset_ms,
                "voice": voice,
            }
        )
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--voice", default="ru-RU-DmitryNeural")
    parser.add_argument("--rate", default="-3%")
    parser.add_argument(
        "--fallbacks",
        default="ru-RU-SvetlanaNeural",
        help="голоса на замену, если основной не отвечает (через запятую)",
    )
    parser.add_argument("--out-mp3", required=True)
    parser.add_argument("--out-json", required=True)
    args = parser.parse_args()

    text = pathlib.Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("текст пуст")

    await synth(
        text,
        args.voice,
        args.rate,
        pathlib.Path(args.out_mp3),
        pathlib.Path(args.out_json),
        [v.strip() for v in args.fallbacks.split(",") if v.strip()],
    )


asyncio.run(main())

# Middle Chinese song

Tang and Song poems sung in reconstructed Middle Chinese to newly composed melodies, accompanied by a synthesized ensemble and performed by a procedural 3D singer. Everything is generated in plain JavaScript: no libraries, no samples, no 3D assets.

- **Music:** a melody composer whose rules are learned from 姜夔's 白石道人歌曲, a formant singing voice built on a Middle Chinese speech synthesizer, and a 燕樂-style band.
- **Singer:** a WebGL2 figure modelled as a signed distance field, with skinning, choreography, lip-sync, sewn cloth, and editors for the body, makeup and shawl.
- **Output:** live in the browser, or rendered to WAV and MP4 (landscape or 9:16).

This file covers running it and the music. The 3D side is described in **STAGE.md**.

## Quick start

Requirements: Node 20+ and Google Chrome (for the video tools, macOS paths). On Apple Silicon use a native arm64 `node`; an x86 node under Rosetta is several times slower. Tools that drive Chrome need `node --experimental-websocket` on Node 20.

| | |
|---|---|
| `python3 -m http.server`, open `stage.html` | the singer: pick a poem, press play (`?style=song` for the Song version) |
| `sing.html` | the music only: compose, play, download WAV, see the 簡譜 score |
| `music.html` | piano roll of every part (voice with lyrics, 簫/笛, 笙, 琵琶/琴, 箏, 阮, percussion), with playback |
| `node tool/maker.js`, open `localhost:8800/maker.html` | **video maker**: paste a poem, pick readings for characters with several (多音字), choose style, mode, tempo, music, format (16:9 / 9:16) and prelude, render an MP4 to `out/` |
| `node render.js 2 --seed 5 --full` | compose and sing a preset to `out/*.wav` and print the score (`node render.js` lists the presets) |
| `node render.js poems.txt [--only 3]` | a file of `# title \| --mode … --tempo … --seed …` sections |
| `node --experimental-websocket tool/video.js --file poems.txt --only 0 --band full` | offline MP4 render (options in STAGE.md) |
| `sh tool/videos.sh` | render every poem in `poems.txt` |

`edit.html`, `face.html` and `shawl.html` are the editors for the body/hair/ornaments, the makeup and the shawl (see STAGE.md).

## Layout

| path | |
|---|---|
| `sing.js` | composer + singing voice + small accompaniment (`SING.compose`, `SING.render`, `SING.score`, `SING.wav`) |
| `band.js` | full ensemble around the voice (`BAND.render`) |
| `speech/mcsynth.js`, `speech/mc_dict.json` | the Middle Chinese speech synthesizer (Baxter → IPA → Klatt-style formants) and its character dictionary |
| `render.js` | command line: poem → WAV |
| `figure.js`, `stage.js`, `stage.html` | the 3D singer |
| `figure.tang.json`, `figure.song.json` | each style's body, hair, costume and makeup |
| `edit.*`, `face.*`, `shawl.*` | editors |
| `cloth_sim/` | the cloth solver (XPBD), used as a library; has its own demo (`cloth_sim/index.html`) and README |
| `sing.html`, `music.html`, `maker.html` | music pages and the video maker |
| `poems.txt` | annotated poems (readings resolved, stanzas split) |
| `tool/` | video rendering, the maker server, the checker, the 白石 corpus and its analysis |

## Text conventions

- Punctuation: `，、：` end a clause; `。！？；` or a new line end a sentence (a rhyme). A blank line starts a new stanza (詞 上下闋).
- Characters with several readings (多音字) use the dictionary's first reading, except for a few better verse defaults (不 pjut, 看 khan, …).
  - Override with `字[2]` (the 2nd reading) or `字[baxter]`. The second form also covers characters missing from the dictionary, e.g. `魂[hwon]`.
  - `node tool/readings.js file.txt` lists every multi-reading character and the reading chosen. The maker shows them as menus.

## How the melody is made

1. **Learned rules.** `tool/baishi.txt` holds 8 songs (559 syllables) of 白石道人歌曲, copied from 丘瓊蓀's 1959 簡譜 transcriptions. `node tool/analyze.js` derives:
   - which interval follows each scale degree;
   - how the tones of a syllable pair bend the melody. After 去 the line tends to rise, after 平 to fall, and 上 is approached from above. Cantonese-style matching of melody to tone height does *not* hold in this corpus (43%).
   - how often each degree is used, and where phrases cadence.

   The resulting tables are embedded at the top of `sing.js`.
2. **Sampling.** Each line is sampled whole from these scores (second-order forward-filtering, backward-sampling), so it can steer toward its cadence. Stanza and quatrain ends land on the mode's final. `temp` sets how adventurous it is.
3. **Repetition.**
   - A quatrain's 4th line reuses the 2nd line's tune, and a 律詩's second half reuses the first.
   - A 詞's second stanza reuses the first, aligned from the end, so a different 換頭 is fine and a line may differ by one syllable.
   - The reuse is soft: notes change where the new tones don't fit.
4. **Rhythm and ornaments.** One beat per syllable, long notes and rests at rhymes, short notes for 入. Turns and two-note slides are added at the corpus rates.

## How it is sung

- The speech synthesizer's plan for each phrase is time-warped onto the notes: consonants keep their natural length, vowels stretch.
- The pitch track becomes the melody, with a scoop into 上, a rising release on 去, clipped 入 and delayed vibrato.
- On high notes the first formant is tuned up to the pitch. The Klatt-style renderer then produces the voice.

**Pronunciation era.** The default is Late Tang (晚唐):
- 上聲 with a voiced obstruent initial becomes 去聲 (濁上變去);
- all four tones split into 陰/陽 registers by the voicing of the initial (四聲八調; 次濁上 stays 陰).

`era: 'high'` (盛唐) keeps 濁上 as 上 and has no register split; voiced initials only lower the pitch onset slightly. Use `--era high` (render.js, tool/video.js), `&era=high` (stage), or the pronunciation menu in the maker.

Beyond Baxter's notation, the synthesizer makes some interpretive choices of its own:
- vowel values roughly in the Zhengzhang/Pulleyblank Early Middle Chinese style;
- breathy 濁 initials;
- tone contours: 平 level, 上 rising, 去 falling, 入 short.

## Accompaniment

- **sing.js:**
  - 簫 heterophony: the tune with graces, echoes in the rests, and a prelude playing the last line.
  - 琵琶 on alternate beats with 輪指 on long cadences.
  - 拍板 on phrase ends (where 丘's 板 marks fall) and a soft drum at phrase starts.
- **band.js:**
  - winds: 笙 clusters, 笛 with membrane buzz, 簫;
  - plucked: 琵琶, 箏 runs, a 阮 low line;
  - percussion: drum pattern, 拍板, 方響.

  The first stanza (or half) is lighter.
- Every instrument is synthesized: additive winds with breath noise, Karplus–Strong plucks, resonator percussion, and a Freeverb-style hall.
- `SING.render` / `BAND.render` accept `intro` (true: the full prelude; a number: only its last n beats; false: none) and `events` (an array that collects every note played, as used by music.html).

## Credits

- Melodic corpus: 姜夔《白石道人歌曲》, as transcribed by 丘瓊蓀《白石道人歌曲通考》(音樂出版社, 1959).
- Middle Chinese readings: Baxter's transcription of the 廣韻 categories.
- Painting references for the costumes include 周昉《簪花仕女圖》, 宋人《歌樂圖》, 李嵩《聽阮圖》 and 錢選《招涼仕女圖》.

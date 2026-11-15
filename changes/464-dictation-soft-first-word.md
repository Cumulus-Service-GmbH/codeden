---
section: fixed
---

- **Dictation with OpenAI, ElevenLabs or local Whisper no longer drops a softly spoken first word.** When you were already speaking quietly as the microphone opened, pause detection took your voice for the room's noise. It only heard you after the first gap between words, so most of the first word never reached the engine. Now, when that gap shows the noise level was set by your voice, the audio from the start is judged again and the whole phrase is sent. This applies to the first two seconds; a noisy room that goes quiet later is still not sent as speech.

---
section: fixed
---

- **Dictation with OpenAI, ElevenLabs or local Whisper no longer sends the hum of a noisy room as speech when it starts.** Pause detection used to learn the room's noise level from zero, which took about five seconds. Until then, a fan or air conditioner louder than the quietest level counted as speech, so the room went to the engine as one long clip (and Whisper tends to invent text for it), and your first phrase came back late with that clip. Now the first fifth of a second sets the noise level. If you are already talking when the microphone opens, you are still heard, and the moment of silence some microphones send while they start doesn't count.

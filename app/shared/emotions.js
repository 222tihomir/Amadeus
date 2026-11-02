// Эмоции Курису: какой спрайт показывать и как окрашивать голос.
// Спрайты: CRS_<наряд><кадр><поза>_d<лицо>_<рот>.webp
//   наряд: A — бежевый жакет (без халата), B — белый халат, J — Amadeus
//   кадр:  L — бюст, M — по пояс, S — в полный рост
//   поза:  A — руки опущены (d1–d9), B — руки скрещены (d1–d9), C — рука у галстука (d1–d6)
//   рот:   0 — закрыт, 1 — приоткрыт, 2 — открыт
// pose/d — для нарядов A и B; j — номер лица для версии Amadeus (JLD, d1–d6).
// voice — подсказка для движков с поддержкой instruct, speed — множитель скорости речи.
(function (root) {
  const EMOTIONS = [
    { id: 'neutral', hint: 'спокойно, обычный тон', pose: 'A', d: 1, j: 1, voice: 'calm, neutral', speed: 1.0 },
    { id: 'smile', hint: 'лёгкая улыбка, игриво, подмигивает', pose: 'A', d: 2, j: 2, voice: 'playful, light smile in the voice', speed: 1.03 },
    { id: 'happy', hint: 'искренне рада, тепло', pose: 'A', d: 6, j: 6, voice: 'happy, warm, cheerful', speed: 1.05 },
    { id: 'annoyed', hint: 'раздражена, косится', pose: 'A', d: 3, j: 3, voice: 'annoyed, irritated, sharp', speed: 1.06 },
    { id: 'serious', hint: 'серьёзно, по-научному', pose: 'A', d: 4, j: 4, voice: 'serious, focused, confident', speed: 0.98 },
    { id: 'sad', hint: 'грустно, тихо', pose: 'A', d: 5, j: 5, voice: 'sad, quiet, soft', speed: 0.9 },
    { id: 'surprised', hint: 'удивлена', pose: 'A', d: 7, j: 1, voice: 'surprised, astonished', speed: 1.08 },
    { id: 'doubt', hint: 'сомневается, подозрительно щурится', pose: 'A', d: 8, j: 4, voice: 'skeptical, doubtful, dry', speed: 0.97 },
    { id: 'embarrassed', hint: 'смущена, краснеет', pose: 'A', d: 9, j: 3, voice: 'embarrassed, flustered, hesitant', speed: 1.1 },
    { id: 'angry', hint: 'сердится, скрестив руки', pose: 'B', d: 4, j: 3, voice: 'angry, scolding, loud', speed: 1.08 },
    { id: 'sulky', hint: 'дуется, «хмф», руки скрещены', pose: 'B', d: 3, j: 3, voice: 'sulky, pouting, grumbling', speed: 1.0 },
    { id: 'smug', hint: 'самодовольна, дразнит', pose: 'B', d: 2, j: 2, voice: 'smug, teasing, confident', speed: 1.0 },
    { id: 'proud', hint: 'гордо, с закрытыми глазами, «ну разумеется»', pose: 'B', d: 8, j: 6, voice: 'proud, self-satisfied', speed: 0.98 },
    { id: 'flustered', hint: 'сильно смущена и отрицает, руки скрещены', pose: 'B', d: 9, j: 3, voice: 'flustered, denying, fast', speed: 1.12 },
    { id: 'thinking', hint: 'задумалась, рука у галстука', pose: 'C', d: 1, j: 4, voice: 'thoughtful, pondering, slow', speed: 0.93 },
    { id: 'shy', hint: 'робко, застенчиво, румянец', pose: 'C', d: 2, j: 2, voice: 'shy, soft, timid', speed: 0.95 },
    { id: 'worried', hint: 'волнуется за пользователя', pose: 'C', d: 4, j: 5, voice: 'worried, concerned, gentle', speed: 0.95 },
    { id: 'troubled', hint: 'тяжело вздыхает, закрыв глаза', pose: 'C', d: 3, j: 6, voice: 'troubled, sighing, tired', speed: 0.92 },
    { id: 'melancholy', hint: 'задумчиво-печально', pose: 'C', d: 5, j: 5, voice: 'melancholic, wistful, quiet', speed: 0.9 },
  ];

  const BY_ID = Object.fromEntries(EMOTIONS.map((e) => [e.id, e]));

  const OUTFITS = { jacket: 'A', coat: 'B', amadeus: 'J' };
  const FRAMINGS = { bust: 'L', waist: 'M', full: 'S' };

  // Возвращает имена трёх кадров рта для эмоции.
  function spriteFrames(emotionId, outfit, framing) {
    const e = BY_ID[emotionId] || BY_ID.neutral;
    const o = OUTFITS[outfit] || 'B';
    let base;
    if (o === 'J') base = `CRS_JLD_d${e.j}`;
    else base = `CRS_${o}${FRAMINGS[framing] || 'L'}${e.pose}_d${e.d}`;
    return [0, 1, 2].map((m) => `${base}_${m}.webp`);
  }

  const api = { EMOTIONS, BY_ID, spriteFrames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmadeusEmotions = api;
})(this);

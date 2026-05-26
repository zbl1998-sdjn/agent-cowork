import { describe, expect, it } from 'vitest';
import { collectSpeechTranscript } from './useComposerVoice';

describe('collectSpeechTranscript', () => {
  it('joins transcripts from speech result alternatives', () => {
    const results = [
      [{ transcript: '打开' }],
      [{ transcript: '工作区' }],
      [{ transcript: '索引' }],
    ];

    expect(collectSpeechTranscript(results)).toBe('打开工作区索引');
  });
});

"""
Provider adapters: synthetic speech -> Caption with Intention manifest.

Why this is the beachhead for CWI adoption: when a machine generated the
speech, most of the hard pipeline collapses.

                        recorded film              synthetic speech
  word onsets           ASR + forced alignment     provider, or clean-audio VAD
  speaker identity      diarization + voice-print  KNOWN (you picked the voice)
  f0 / loudness         estimated from a mix       exact (clean, isolated stem)
  on/off camera         active-speaker detection   KNOWN (you composited it)

Two of the three model-dependent stages disappear entirely, and the acoustic
measurements get better because there is no music or room to contaminate them.
"""

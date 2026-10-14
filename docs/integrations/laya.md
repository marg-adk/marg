# Laya and System One servers

The decision model in Verdict's cascade: routing, reading a confirmation, checking a condition, answered with calibrated probabilities in ~30 ms before an LLM is asked. Laya is open weights (Apache-2.0) and runs under Ollama; any server speaking the System One protocol works. [Decisions](../DECISIONS.md).

```bash
VERDICT_SYSTEMONE_URL=http://localhost:11434   # ollama pull laya
VERDICT_SYSTEMONE_MODEL=laya
VERDICT_MIN_CONFIDENCE=0.6
```

Docs: https://github.com/NandhaKishorM/laya

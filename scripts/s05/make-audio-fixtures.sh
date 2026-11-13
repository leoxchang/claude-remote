#!/bin/bash
#
# Generate non-private Chinese PCM fixtures for S05 ASR tests.
# Uses the macOS system voice and converts to 16 kHz mono signed PCM16
# without a WAV header. No personal recordings are read or written.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly OUT_DIR="${REPO_ROOT}/apps/agent/test/fixtures/s05/audio"
readonly SAMPLE_RATE=16000
readonly VOICE="Tingting"

err() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')]: $*" >&2
}

# Strip the RIFF/WAVE header and keep the raw data chunk.
wav_to_pcm() {
  local wav="$1"
  local pcm="$2"
  local data_offset

  data_offset="$(LC_ALL=C grep -abo 'data' "${wav}" | head -n1 | cut -d: -f1)"
  if [[ -z "${data_offset}" ]]; then
    err "no data chunk in ${wav}"
    return 1
  fi
  dd if="${wav}" of="${pcm}" bs=1 skip="$((data_offset + 8))" 2>/dev/null
  rm -f "${wav}"
}

# Synthesize one sentence and convert it to headerless PCM16.
make_fixture() {
  local name="$1"
  local text="$2"
  local aiff="${OUT_DIR}/${name}.aiff"
  local wav="${OUT_DIR}/${name}.wav"
  local pcm="${OUT_DIR}/${name}.pcm"

  say -v "${VOICE}" -o "${aiff}" "${text}"
  afconvert -f WAVE -d "LEI16@${SAMPLE_RATE}" -c 1 "${aiff}" "${wav}"
  rm -f "${aiff}"
  wav_to_pcm "${wav}" "${pcm}"

  local size
  size="$(stat -f%z "${pcm}")"
  if ((size == 0 || size % 2 != 0)); then
    err "invalid PCM size for ${pcm}: ${size}"
    return 1
  fi
  echo "wrote ${pcm} (${size} bytes)" >&2
}

main() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    err "this script requires macOS say/afconvert"
    exit 1
  fi
  mkdir -p "${OUT_DIR}"

  make_fixture "single-zh" "请帮我检查这个仓库的测试。"
  make_fixture "multi-zh" "第一句，打开项目。第二句，运行测试。"
  make_fixture "mixed-zh-en" "请运行 npm test 并告诉我结果。"
}

main "$@"
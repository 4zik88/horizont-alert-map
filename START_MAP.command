#!/bin/bash
# ЗАЛІЗНЕ НЕБО — запуск карти на macOS
# Аналог START_MAP.bat для Windows. Подвійний клік у Finder запускає сервер.

cd "$(dirname "$0")" || exit 1

# Пошук Python 3: спочатку офіційний launcher, потім python3 у PATH,
# потім типові шляхи Homebrew (Apple Silicon / Intel).
PY=""
if command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
elif [ -x /usr/local/bin/python3 ]; then
  PY=/usr/local/bin/python3
elif [ -x /opt/homebrew/bin/python3 ]; then
  PY=/opt/homebrew/bin/python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' 2>/dev/null; then
  PY="$(command -v python)"
fi

if [ -z "$PY" ]; then
  echo "Python 3 не знайдено."
  echo "Встановіть його командою:  brew install python"
  echo "або завантажте з https://www.python.org/downloads/macos/"
  echo
  echo "Натисніть Enter, щоб закрити вікно."
  read -r _
  exit 1
fi

echo "Python: $PY"
echo "Запуск сервера карти... Не закривайте це вікно, поки користуєтесь картою."
echo "Зупинити сервер: Ctrl+C"
echo

"$PY" -u server.py
STATUS=$?

echo
if [ $STATUS -ne 0 ]; then
  echo "Сервер завершився з помилкою (код $STATUS)."
else
  echo "Сервер зупинено."
fi
echo "Натисніть Enter, щоб закрити вікно."
read -r _

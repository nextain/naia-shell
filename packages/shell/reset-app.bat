@echo off
echo Resetting Naia app state...

set LEVELDB=%LOCALAPPDATA%\com.naia.shell\EBWebView\Default\Local Storage\leveldb

if exist "%LEVELDB%" (
    rmdir /s /q "%LEVELDB%"
    echo Done. localStorage cleared.
) else (
    echo Nothing to clear (already clean).
)

pause

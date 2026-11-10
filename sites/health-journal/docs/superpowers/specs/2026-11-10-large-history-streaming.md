# Stream full Apple Health history and retain selected month

User's Apple ZIP is15.47MB compressed, but its XML exceeds the old150MiB cap. Apple exports all history without a month selector. The issue is our whole-document memory strategy and unhelpful smaller-file advice, not the selected archive.

Use the existing private Site and database. Stream ZIP/XML slices, maintain CRC/size/path/localized filename checks, parse XML through SAX, retain only supported records within recent30days or selected calendar month. Include2days of sleep buffer on each side; normalize complete sessions before final waking-date filter. Scan the full file to validate malformed tails/CRC before any upload. The user can continue using the original archive.

Do not simply enlarge DOM memory. Streaming path allows up to4GiB input/XML; ZIP64 remains unsupported and can use a directly extracted XML within the same bound. Selected fragment remains bounded64MiB/200000records, so dense single-month data produces a clear scope-specific limit instead of exhausting the phone. Legacy no-window reader keeps its150MiB limit only for compatibility; webpage always supplies dates.

Archive worker owns bounded decoding, CRC, abort/progress and yielding. XML filter owns strict HealthData validation, dates, safe reserialization and selected-output bound. Parent integrates import scope controls/progress/consistent mapping/final sleep filtering, dependency notices/docs, synthetic >150MiB regression, independent review, exact-source private publish and sanitized GitHub push. No real health file needed or uploaded to chat/source.

## Verification and review
Full128Node tests passed after streaming build. Archive tests include actual151MiB generatedXML and compressedZIP, boundedheap/timerheartbeat/full-tailCRC/abort checks. SAXmodule has19targeted tests, including directly-rooted FoodCorrelation nutrition restored after independentreview; rootmanuallycompletedthatfix when revieweragentbecameunavailable. Existing actual-page tests verify chosenmonth, sleepboundaries and previous record retention. No user archive or real records were needed.

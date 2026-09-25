<?php
/*
 * Outgoing email: Amazon SES (API v2, signed with AWS Signature Version 4) or, until SES
 * is configured, a log file (DATA_DIR/mail.log) so the flows can be tested.
 */
declare(strict_types=1);
defined('NADIR') || exit;

// AWS Signature Version 4: returns the Authorization header value.
function awsSigV4(string $method, string $host, string $path, string $query, array $headers, string $payload,
                  string $region, string $service, string $key, string $secret, string $amzDate): string {
    $date = substr($amzDate, 0, 8);
    $canon = [];
    foreach ($headers as $name => $value) $canon[strtolower($name)] = trim((string) $value);
    ksort($canon);
    $canonicalHeaders = '';
    foreach ($canon as $name => $value) $canonicalHeaders .= "$name:$value\n";
    $signedHeaders = implode(';', array_keys($canon));
    $canonicalRequest = "$method\n$path\n$query\n$canonicalHeaders\n$signedHeaders\n" . hash('sha256', $payload);
    $scope = "$date/$region/$service/aws4_request";
    $stringToSign = "AWS4-HMAC-SHA256\n$amzDate\n$scope\n" . hash('sha256', $canonicalRequest);
    $k = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
    $k = hash_hmac('sha256', $region, $k, true);
    $k = hash_hmac('sha256', $service, $k, true);
    $k = hash_hmac('sha256', 'aws4_request', $k, true);
    $signature = hash_hmac('sha256', $stringToSign, $k);
    return "AWS4-HMAC-SHA256 Credential=$key/$scope, SignedHeaders=$signedHeaders, Signature=$signature";
}

function sesSend(array $c, string $to, string $subject, string $text, string $html): bool {
    $host = "email.{$c['region']}.amazonaws.com";
    $path = '/v2/email/outbound-emails';
    $payload = json_encode([
        'FromEmailAddress' => $c['from'],
        'Destination' => ['ToAddresses' => [$to]],
        'Content' => ['Simple' => [
            'Subject' => ['Data' => $subject, 'Charset' => 'UTF-8'],
            'Body' => ['Text' => ['Data' => $text, 'Charset' => 'UTF-8'], 'Html' => ['Data' => $html, 'Charset' => 'UTF-8']],
        ]],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $amzDate = gmdate('Ymd\THis\Z');
    $headers = ['Content-Type' => 'application/json', 'Host' => $host, 'X-Amz-Date' => $amzDate];
    $auth = awsSigV4('POST', $host, $path, '', $headers, $payload, $c['region'], 'ses', $c['key'], $c['secret'], $amzDate);
    $ctx = stream_context_create(['http' => [
        'method' => 'POST', 'timeout' => 15, 'ignore_errors' => true, 'content' => $payload,
        'header' => "Content-Type: application/json\r\nX-Amz-Date: $amzDate\r\nAuthorization: $auth\r\n",
    ]]);
    $body = (string) @file_get_contents("https://$host$path", false, $ctx);
    $result = json_decode($body, true);
    if (is_array($result) && !empty($result['MessageId'])) return true;
    // Errors come back as JSON with a message; keep them for diagnosis.
    @file_put_contents(DATA_DIR . '/mail-errors.log', gmdate('c') . " to=$to " . substr($body, 0, 500) . "\n", FILE_APPEND);
    return false;
}

function sendMail(string $to, string $subject, string $text, string $html): bool {
    $mail = config()['mail'];
    if (($mail['driver'] ?? 'log') === 'ses') return sesSend($mail, $to, $subject, $text, $html);
    $entry = "=== " . gmdate('c') . " To: $to\nSubject: $subject\n\n$text\n";
    return @file_put_contents(DATA_DIR . '/mail.log', $entry, FILE_APPEND) !== false;
}

// A short email with one button. $lines are plain-text paragraphs.
function sendActionMail(string $to, string $subject, array $lines, ?string $buttonText = null, ?string $url = null): bool {
    $text = implode("\n\n", $lines) . ($url ? "\n\n$buttonText:\n$url" : '') . "\n\n— Nadir Lab\n" . config()['site_url'];
    $html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.5">'
          . '<p style="font-size:20px;font-weight:600;margin:24px 0 16px">Nadir Lab</p>';
    foreach ($lines as $line) $html .= '<p>' . htmlspecialchars($line) . '</p>';
    if ($url) {
        $u = htmlspecialchars($url);
        $html .= '<p style="margin:24px 0"><a href="' . $u . '" style="background:#0d6efd;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">'
               . htmlspecialchars($buttonText) . '</a></p>'
               . '<p style="font-size:13px;color:#666">Or paste this link into your browser:<br>' . $u . '</p>';
    }
    $html .= '<p style="font-size:13px;color:#666;margin-top:32px">Nadir Lab · <a href="' . htmlspecialchars(config()['site_url']) . '">'
           . htmlspecialchars(preg_replace('#^https?://|/$#', '', config()['site_url'])) . '</a></p></div>';
    return sendMail($to, $subject, $text, $html);
}

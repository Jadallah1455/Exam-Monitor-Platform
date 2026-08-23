<?php
/**
 * Sync Now — standalone page.
 * Visit: /mod/quiz/accessrule/exammonitor/sync_now.php
 * Requires Moodle admin login.
 * Shows results directly on page.
 */

require_once(__DIR__ . '/../../../../config.php');
require_login();

global $DB, $CFG, $OUTPUT, $PAGE;

// Must be admin
require_capability('moodle/site:config', context_system::instance());

$server = get_config('quizaccess_exammonitor', 'sync_server');
$secret = get_config('quizaccess_exammonitor', 'sync_secret');

$PAGE->set_url(new moodle_url('/mod/quiz/accessrule/exammonitor/sync_now.php'));
$PAGE->set_context(context_system::instance());
$PAGE->set_title('Exam Monitor — Sync');
$PAGE->set_heading('Exam Monitor — Data Sync');

echo $OUTPUT->header();

if (empty($server) || empty($secret)) {
    echo $OUTPUT->notification('Please configure Sync Server and Plugin Key first in Site Administration → Plugins → Activity Modules → Exam Monitor.', 'notifyerror');
    echo '<p><a href="' . $CFG->wwwroot . '/admin/settings.php?section=quizaccess_exammonitorsettings">← Back to Settings</a></p>';
    echo $OUTPUT->footer();
    exit;
}

// ── Collect all data from Moodle ──────────────────────────────────────

// 1. Courses
$coursesRaw = $DB->get_records_sql("SELECT id, fullname FROM {course} WHERE id > 1 ORDER BY id ASC");
$courses = [];
foreach ($coursesRaw as $c) {
    $courses[] = ['id' => (int)$c->id, 'fullname' => (string)$c->fullname];
}

// 2. Teachers
$teachersRaw = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype IN ('teacher', 'editingteacher')
        AND u.deleted = 0
      ORDER BY u.id ASC"
);
$teachers = [];
foreach ($teachersRaw as $t) {
    $teachers[] = [
        'id' => (int)$t->id,
        'username' => (string)$t->username,
        'fullname' => trim((string)$t->firstname . ' ' . (string)$t->lastname),
    ];
}

// 3. Students
$studentsRaw = $DB->get_records_sql(
    "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype = 'student'
        AND u.deleted = 0
      ORDER BY u.id ASC"
);
$students = [];
foreach ($studentsRaw as $s) {
    $students[] = [
        'id' => (int)$s->id,
        'username' => (string)$s->username,
        'fullname' => trim((string)$s->firstname . ' ' . (string)$s->lastname),
    ];
}

// 4. Quizzes
$quizzesRaw = $DB->get_records_sql(
    "SELECT q.id, q.name, q.course, q.timelimit, cm.id AS cmid
       FROM {quiz} q
       JOIN {course_modules} cm ON cm.instance = q.id AND cm.module = (
           SELECT id FROM {modules} WHERE name = 'quiz' LIMIT 1
       )
       ORDER BY q.id ASC"
);
$quizzes = [];
foreach ($quizzesRaw as $q) {
    $quizzes[] = [
        'id' => (int)$q->id,
        'name' => (string)$q->name,
        'course' => (int)$q->course,
        'cmid' => (int)$q->cmid,
        'duration_minutes' => (int)($q->timelimit > 0 ? round($q->timelimit / 60) : 0),
    ];
}

// 5. Enrollments
$enrollmentsRaw = $DB->get_recordset_sql(
    "SELECT DISTINCT ra.userid, c.instanceid AS courseid, u.firstname, u.lastname
       FROM {role_assignments} ra
       JOIN {context} c ON c.id = ra.contextid
       JOIN {role} r ON r.id = ra.roleid
       JOIN {user} u ON u.id = ra.userid
      WHERE c.contextlevel = " . CONTEXT_COURSE . "
        AND r.archetype IN ('teacher', 'editingteacher')
        AND u.deleted = 0
      ORDER BY c.instanceid, ra.userid"
);
$enrollments = [];
foreach ($enrollmentsRaw as $e) {
    $enrollments[] = [
        'course_id' => (int)$e->courseid,
        'teacher_id' => (int)$e->userid,
        'teacher_name' => trim((string)$e->firstname . ' ' . (string)$e->lastname),
    ];
}
$enrollmentsRaw->close();

// ── Show what was collected ───────────────────────────────────────────

echo '<div style="max-width:600px;margin:0 auto;">';

echo '<h3>Data collected from Moodle:</h3>';
echo '<div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0;">';
$cards = [
    ['Courses', count($courses), '#2563eb'],
    ['Teachers', count($teachers), '#0891b2'],
    ['Students', count($students), '#7c3aed'],
    ['Quizzes', count($quizzes), '#d97706'],
    ['Teacher-Course Links', count($enrollments), '#16a34a'],
];
foreach ($cards as $c) {
    echo '<div style="flex:1 1 100px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;">';
    echo '<div style="font-size:28px;font-weight:800;color:' . $c[2] . ';">' . $c[1] . '</div>';
    echo '<div style="font-size:13px;color:#64748b;font-weight:600;margin-top:4px;">' . $c[0] . '</div>';
    echo '</div>';
}
echo '</div>';

// ── Push to backend ───────────────────────────────────────────────────

$url = rtrim((string)$server, '/') . '/api/sync/bulk';
$payload = json_encode([
    'secret' => (string)$secret,
    'site_url' => (string)$CFG->wwwroot,
    'courses' => $courses,
    'teachers' => $teachers,
    'students' => $students,
    'quizzes' => $quizzes,
    'enrollments' => $enrollments,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_CONNECTTIMEOUT => 10,
]);
$response = curl_exec($ch);
$err = curl_error($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// ── Show result ───────────────────────────────────────────────────────

if ($response === false || $response === '') {
    echo '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;margin-top:20px;text-align:center;">';
    echo '<div style="font-size:40px;">&#10060;</div>';
    echo '<h3 style="color:#dc2626;">Sync Failed</h3>';
    echo '<p style="color:#7f1d1d;">' . s($err) . '</p>';
    echo '</div>';
} else {
    $decoded = json_decode($response, true);
    if (is_array($decoded) && !empty($decoded['ok'])) {
        $synced = $decoded['synced'] ?? $decoded['data']['synced'] ?? [];
        echo '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin-top:20px;text-align:center;">';
        echo '<div style="font-size:40px;">&#9989;</div>';
        echo '<h3 style="color:#16a34a;">Sync Completed Successfully!</h3>';
        echo '<p style="color:#166534;font-size:16px;font-weight:700;">';
        echo 'Courses: ' . ($synced['courses'] ?? 0) . '<br>';
        echo 'Teachers: ' . ($synced['teachers'] ?? 0) . '<br>';
        echo 'Students: ' . ($synced['students'] ?? 0) . '<br>';
        echo 'Quizzes: ' . ($synced['quizzes'] ?? 0) . '<br>';
        echo 'Links: ' . ($synced['enrollments'] ?? 0);
        echo '</p>';
        echo '</div>';
    } else {
        $msg = is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : 'Unknown error';
        echo '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;margin-top:20px;text-align:center;">';
        echo '<div style="font-size:40px;">&#10060;</div>';
        echo '<h3 style="color:#dc2626;">Sync Error</h3>';
        echo '<p style="color:#7f1d1d;">' . s($msg) . '</p>';
        echo '</div>';
    }
}

echo '<p style="margin-top:24px;text-align:center;"><a href="' . $CFG->wwwroot . '/admin/settings.php?section=quizaccess_exammonitorsettings" style="color:#2563eb;">← Back to Exam Monitor Settings</a></p>';
echo '</div>';

echo $OUTPUT->footer();

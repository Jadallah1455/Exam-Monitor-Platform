<?php

defined('MOODLE_INTERNAL') || die();

class quizaccess_exammonitor extends \mod_quiz\local\access_rule_base {

    /** Per-quiz enforcement toggles (columns of the settings table). */
    private static function toggles(): array {
        return [
            'exammonitor_enabled'       => 'enabled',
            'exammonitor_block_copy'    => 'block_copy',
            'exammonitor_block_paste'   => 'block_paste',
            'exammonitor_block_rightclick' => 'block_rightclick',
            'exammonitor_block_print'   => 'block_print',
            'exammonitor_block_shortcuts' => 'block_shortcuts',
        ];
    }

    public static function make($quizobj, $timenow, $canignoretimelimits) {
        return new self($quizobj, $timenow);
    }

    public static function add_settings_form_fields(
        mod_quiz_mod_form $quizform,
        MoodleQuickForm $mform
    ) {
        $mform->addElement(
            'header',
            'exammonitor_header',
            get_string('pluginname', 'quizaccess_exammonitor')
        );

        $mform->addElement(
            'advcheckbox',
            'exammonitor_enabled',
            get_string('enablemonitor', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_enabled', 1);

        $mform->addElement(
            'static',
            'exammonitor_enforce_info',
            '',
            get_string('enforceinfo', 'quizaccess_exammonitor')
        );

        $mform->addElement(
            'advcheckbox',
            'exammonitor_block_copy',
            get_string('blockcopy', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_block_copy', 0);

        $mform->addElement(
            'advcheckbox',
            'exammonitor_block_paste',
            get_string('blockpaste', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_block_paste', 0);

        $mform->addElement(
            'advcheckbox',
            'exammonitor_block_rightclick',
            get_string('blockrightclick', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_block_rightclick', 0);

        $mform->addElement(
            'advcheckbox',
            'exammonitor_block_print',
            get_string('blockprint', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_block_print', 0);

        $mform->addElement(
            'advcheckbox',
            'exammonitor_block_shortcuts',
            get_string('blockshortcuts', 'quizaccess_exammonitor')
        );
        $mform->setDefault('exammonitor_block_shortcuts', 0);
    }

    public static function save_settings($quiz) {
        global $USER, $DB, $CFG;

        if (!empty($quiz->id) && !empty($quiz->course)) {
            self::save_quiz_settings($quiz);
        }

        if (empty($quiz->exammonitor_enabled)) {
            return;
        }

        if (empty($quiz->id) || empty($quiz->course)) {
            return;
        }

        $course = $DB->get_record(
            'course',
            ['id' => $quiz->course],
            'id, fullname',
            MUST_EXIST
        );

        $teacherdata = [
            'secret' => (string) get_config('quizaccess_exammonitor', 'sync_secret'),
            'site_url' => (string) $CFG->wwwroot,
            'teacher_id' => (int) $USER->id,
            'teacher_name' => fullname($USER),
            'username' => $USER->username,
            'course_id' => (int) $course->id,
            'course_name' => $course->fullname,
            'quiz_id' => (int) $quiz->id,
            'quiz_name' => $quiz->name,
            'cmid' => (int) optional_param('update', 0, PARAM_INT)
        ];

        $server = get_config('quizaccess_exammonitor', 'sync_server');
        if (empty($server)) {
            $server = 'https://jadallahkhaled.com';
        }
        $backendurl = rtrim((string) $server, '/') . '/register-teacher';

        require_once($CFG->libdir . '/filelib.php');

        $curl = new curl();

        $options = [
            'CURLOPT_TIMEOUT' => 5,
            'CURLOPT_CONNECTTIMEOUT' => 3
        ];

        try {
            $curl->post(
                $backendurl,
                json_encode($teacherdata),
                $options,
                ['Content-Type: application/json']
            );
        } catch (Throwable $e) {
            debugging(
                'SOAR teacher registration failed: ' . $e->getMessage(),
                DEBUG_DEVELOPER
            );
        }
    }

    public static function delete_settings($quiz) {
        global $DB;
        if (!empty($quiz->id)) {
            $DB->delete_records('quizaccess_exammonitor', ['quizid' => $quiz->id]);
        }
    }

    public static function get_extra_settings($quizid) {
        global $DB;

        $settings = [
            'exammonitor_enabled' => 1,
            'exammonitor_block_copy' => 0,
            'exammonitor_block_paste' => 0,
            'exammonitor_block_rightclick' => 0,
            'exammonitor_block_print' => 0,
            'exammonitor_block_shortcuts' => 0,
        ];

        $row = $DB->get_record('quizaccess_exammonitor', ['quizid' => (int) $quizid]);
        if ($row) {
            foreach (self::toggles() as $field => $col) {
                $settings[$field] = (int) $row->$col;
            }
        }

        return $settings;
    }

    public function setup_attempt_page($page) {
        global $PAGE, $USER, $DB;

        $quiz = $this->quizobj->get_quiz();
        $course = $this->quizobj->get_course();
        $cm = $this->quizobj->get_cm();

        $attemptid = optional_param('attempt', 0, PARAM_INT);

        // Load the per-quiz settings (defaults mirror get_extra_settings()).
        $settings = self::get_extra_settings($quiz->id);

        if (empty($settings['exammonitor_enabled'])) {
            return;
        }

        // Derive the course teachers from Moodle role assignments
        // (archetype teacher/editingteacher in the course context).
        $teacherusers = $DB->get_records_sql(
            "SELECT DISTINCT u.id, u.username, u.firstname, u.lastname, u.email
               FROM {role_assignments} ra
               JOIN {context} c ON c.id = ra.contextid
               JOIN {role} r ON r.id = ra.roleid
               JOIN {user} u ON u.id = ra.userid
              WHERE c.contextlevel = " . CONTEXT_COURSE . "
                AND c.instanceid = :courseid
                AND r.archetype IN ('teacher', 'editingteacher')
                AND u.deleted = 0
              ORDER BY r.sortorder ASC, u.firstname ASC",
            ['courseid' => $course->id]
        );

        $teachers = [];
        foreach ($teacherusers as $t) {
            $teachers[] = [
                'id' => (int) $t->id,
                'fullname' => fullname($t),
                'username' => $t->username
            ];
        }

        $server = get_config('quizaccess_exammonitor', 'sync_server');
        if (empty($server)) {
            $server = 'https://jadallahkhaled.com';
        }

        $secret = (string) get_config('quizaccess_exammonitor', 'sync_secret');

        $config = [
            'site_url' => (string) $CFG->wwwroot,
            'student' => [
                'id' => (int) $USER->id,
                'fullname' => fullname($USER),
                'username' => $USER->username
            ],
            'teacher' => $teachers,
            'quiz' => [
                'id' => (int) $quiz->id,
                'name' => $quiz->name,
                'attempt_id' => (int) $attemptid,
                'course_id' => (int) $course->id,
                'cmid' => (int) $cm->id
            ],
            'settings' => [
                'debug' => true,
                'send_enabled' => true,
                'server_url' => rtrim((string) $server, '/') . '/telemetry?k=' . rawurlencode($secret),
                'sync_secret' => $secret,
                'enforce' => [
                    'copy' => (bool) $settings['exammonitor_block_copy'],
                    'paste' => (bool) $settings['exammonitor_block_paste'],
                    'rightclick' => (bool) $settings['exammonitor_block_rightclick'],
                    'print' => (bool) $settings['exammonitor_block_print'],
                    'shortcuts' => (bool) $settings['exammonitor_block_shortcuts'],
                ],
            ],
        ];

        $PAGE->requires->js_call_amd('quizaccess_exammonitor/monitor', 'init', [$config]);
    }

    /** Upsert the per-quiz settings row. */
    private static function save_quiz_settings($quiz): void {
        global $DB;

        $data = ['quizid' => (int) $quiz->id];
        foreach (self::toggles() as $field => $col) {
            $data[$col] = !empty($quiz->$field) ? 1 : 0;
        }

        $existing = $DB->get_record('quizaccess_exammonitor', ['quizid' => $data['quizid']]);
        if ($existing) {
            foreach ($data as $col => $val) {
                $existing->$col = $val;
            }
            $DB->update_record('quizaccess_exammonitor', $existing);
        } else {
            $DB->insert_record('quizaccess_exammonitor', (object) $data);
        }
    }
}

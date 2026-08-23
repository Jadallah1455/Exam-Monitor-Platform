<?php

defined('MOODLE_INTERNAL') || die();

/**
 * Upgrade the Exam Monitor quiz access rule.
 *
 * 2026081300: adds the per-quiz settings table (monitoring enabled flag +
 * optional enforcement toggles for copy / paste / right-click / print /
 * developer shortcuts).
 */
function xmldb_quizaccess_exammonitor_upgrade($oldversion) {
    global $DB;

    $dbman = $DB->get_manager();

    if ($oldversion < 2026081300) {
        $table = new xmldb_table('quizaccess_exammonitor');

        if (!$dbman->table_exists($table)) {
            $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE, null);
            $table->add_field('quizid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
            $table->add_field('enabled', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '1');
            $table->add_field('block_copy', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0');
            $table->add_field('block_paste', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0');
            $table->add_field('block_rightclick', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0');
            $table->add_field('block_print', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0');
            $table->add_field('block_shortcuts', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0');

            $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
            $table->add_key('quizid', XMLDB_KEY_UNIQUE, ['quizid']);

            $dbman->create_table($table);
        }

        upgrade_plugin_savepoint(true, 2026081300, 'quizaccess', 'exammonitor');
    }

    return true;
}

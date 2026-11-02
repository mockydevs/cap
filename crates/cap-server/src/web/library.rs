//! Library edits: staff notes, display titles and archiving.
//!
//! Everything here writes only the `library_*` tables. The recorded meeting
//! (its title, transcript, audio and the frozen Calari delivery) is never
//! touched, so nothing is re-sent to Calari and no Calari task is duplicated.
//!
//! Every handler: live Calari check (the `WebUser` extractor), admin-only
//! (same rule as viewing), same-origin form with this session's token, and
//! the meeting must belong to the user's tenant. Forms post and redirect
//! back; a stale form gets a 409 page that keeps the user's text.

use super::auth::WebUser;
use super::pages::{self, Draft, DraftTarget, Flash};
use crate::{error::ApiError, AppState};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form,
};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_NOTE_CHARS: usize = 20_000;
pub const MAX_NOTES_PER_MEETING: i64 = 100;

/// Same-origin form with this session's token.
fn form_ok(state: &AppState, headers: &HeaderMap, user: &WebUser, csrf: &str) -> bool {
    let same_site = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|o| o == state.cfg.public_base_url);
    same_site && !csrf.is_empty() && csrf == user.csrf()
}

fn expired_form() -> Response {
    (
        StatusCode::FORBIDDEN,
        "This form expired. Reload the page and try again.",
    )
        .into_response()
}

/// Checks the viewer and form, then returns the meeting's pipeline state if
/// the meeting belongs to the viewer's tenant.
async fn guard(
    state: &AppState,
    headers: &HeaderMap,
    user: &WebUser,
    csrf: &str,
    id: Uuid,
) -> Result<String, Response> {
    if let Some(r) = pages::library_denied(user) {
        return Err(r);
    }
    if !form_ok(state, headers, user, csrf) {
        return Err(expired_form());
    }
    let st: Option<String> = sqlx::query_scalar(
        "SELECT m.state FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         WHERE m.id = $1 AND p.tenant_id = $2",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::from(e).into_response())?;
    st.ok_or_else(|| pages::not_found(user))
}

fn done(id: Uuid, what: &str, anchor: &str) -> Response {
    Redirect::to(&format!("/meetings/{id}?done={what}#{anchor}")).into_response()
}

async fn problem(
    state: &AppState,
    user: &WebUser,
    id: Uuid,
    status: StatusCode,
    message: &str,
    draft: Option<Draft>,
) -> Response {
    pages::render_meeting(
        state,
        user,
        id,
        Flash {
            problem: Some(message.to_owned()),
            draft,
            ..Flash::default()
        },
        status,
    )
    .await
}

/// Ensures the library row exists (version 0, nothing changed yet).
async fn ensure_row<'e, E: sqlx::PgExecutor<'e>>(
    db: E,
    id: Uuid,
    tenant: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO library_meetings (meeting_id, tenant_id) VALUES ($1, $2) ON CONFLICT (meeting_id) DO NOTHING",
    )
    .bind(id)
    .bind(tenant)
    .execute(db)
    .await
    .map(|_| ())
}

async fn audit<'e, E: sqlx::PgExecutor<'e>>(
    db: E,
    user: &WebUser,
    id: Uuid,
    note: Option<Uuid>,
    action: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO library_audit (tenant_id, meeting_id, note_id, actor, action) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&user.tenant_id)
    .bind(id)
    .bind(note)
    .bind(&user.user_id)
    .bind(action)
    .execute(db)
    .await
    .map(|_| ())
}

/// One line, no control characters, single spaces.
pub fn clean_title(raw: &str) -> String {
    raw.split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Unix line endings, no other control characters except tabs, no trailing blank space.
pub fn clean_note(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect::<String>()
        .trim_end()
        .trim_start_matches('\n')
        .to_owned()
}

/// Why a version-checked update matched nothing.
async fn meta_miss(state: &AppState, id: Uuid) -> sqlx::Result<(bool, i32)> {
    let r = sqlx::query("SELECT archived_at IS NOT NULL AS archived, version FROM library_meetings WHERE meeting_id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    Ok(r.map(|r| (r.get("archived"), r.get("version")))
        .unwrap_or((false, 0)))
}

#[derive(Deserialize)]
pub struct TitleForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    version: i32,
    #[serde(default)]
    title: String,
}

/// POST /meetings/{id}/title. An empty title goes back to the recorded one.
pub async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path(id): Path<Uuid>,
    Form(f): Form<TitleForm>,
) -> Response {
    if let Err(r) = guard(&state, &headers, &user, &f.csrf, id).await {
        return r;
    }
    let title = clean_title(&f.title);
    let draft = || {
        Some(Draft {
            target: DraftTarget::Title,
            text: title.chars().take(MAX_TITLE_CHARS * 2).collect(),
        })
    };
    if title.chars().count() > MAX_TITLE_CHARS {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("Titles can be at most {MAX_TITLE_CHARS} characters."),
            draft(),
        )
        .await;
    }
    let recorded: String =
        match sqlx::query_scalar("SELECT title FROM meeting_sessions WHERE id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await
        {
            Ok(t) => t,
            Err(e) => return ApiError::from(e).into_response(),
        };
    let stored = (!title.is_empty() && title != recorded).then_some(title.clone());
    let res: sqlx::Result<_> = async {
        ensure_row(&state.db, id, &user.tenant_id).await?;
        let v: Option<i32> = sqlx::query_scalar(
            "UPDATE library_meetings SET display_title = $3, version = version + 1, updated_at = now(), updated_by = $4
             WHERE meeting_id = $1 AND tenant_id = $2 AND version = $5 AND archived_at IS NULL RETURNING version",
        )
        .bind(id)
        .bind(&user.tenant_id)
        .bind(&stored)
        .bind(&user.user_id)
        .bind(f.version)
        .fetch_optional(&state.db)
        .await?;
        if v.is_some() {
            audit(&state.db, &user, id, None, if stored.is_some() { "rename" } else { "reset_title" }).await?;
        }
        sqlx::Result::Ok(v)
    }
    .await;
    match res {
        Ok(Some(_)) => done(id, "renamed", "title"),
        Ok(None) => match meta_miss(&state, id).await {
            Ok((true, _)) => problem(&state, &user, id, StatusCode::CONFLICT, "This meeting is archived. Restore it before renaming.", draft()).await,
            Ok(_) => problem(
                &state,
                &user,
                id,
                StatusCode::CONFLICT,
                "Someone changed this meeting while you were editing. Your title is kept in the form; check the current title and save again.",
                draft(),
            )
            .await,
            Err(e) => ApiError::from(e).into_response(),
        },
        Err(e) => ApiError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct VersionForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    version: i32,
}

/// POST /meetings/{id}/archive. Hides the meeting from the main list.
/// Nothing is deleted: audio, transcript and notes stay, and it can be restored.
pub async fn archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path(id): Path<Uuid>,
    Form(f): Form<VersionForm>,
) -> Response {
    let st = match guard(&state, &headers, &user, &f.csrf, id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if st != "delivered" && st != "failed" {
        return problem(
            &state,
            &user,
            id,
            StatusCode::CONFLICT,
            "This meeting is still being recorded or processed. Archive it once it has finished.",
            None,
        )
        .await;
    }
    set_archived(state, user, id, f.version, true).await
}

/// POST /meetings/{id}/restore
pub async fn restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path(id): Path<Uuid>,
    Form(f): Form<VersionForm>,
) -> Response {
    if let Err(r) = guard(&state, &headers, &user, &f.csrf, id).await {
        return r;
    }
    set_archived(state, user, id, f.version, false).await
}

async fn set_archived(
    state: AppState,
    user: WebUser,
    id: Uuid,
    version: i32,
    archive: bool,
) -> Response {
    let res: sqlx::Result<_> = async {
        ensure_row(&state.db, id, &user.tenant_id).await?;
        let v: Option<i32> = sqlx::query_scalar(if archive {
            "UPDATE library_meetings SET archived_at = now(), archived_by = $3, version = version + 1, updated_at = now(), updated_by = $3
             WHERE meeting_id = $1 AND tenant_id = $2 AND version = $4 AND archived_at IS NULL RETURNING version"
        } else {
            "UPDATE library_meetings SET archived_at = NULL, archived_by = NULL, version = version + 1, updated_at = now(), updated_by = $3
             WHERE meeting_id = $1 AND tenant_id = $2 AND version = $4 AND archived_at IS NOT NULL RETURNING version"
        })
        .bind(id)
        .bind(&user.tenant_id)
        .bind(&user.user_id)
        .bind(version)
        .fetch_optional(&state.db)
        .await?;
        if v.is_some() {
            audit(&state.db, &user, id, None, if archive { "archive" } else { "restore" }).await?;
        }
        sqlx::Result::Ok(v)
    }
    .await;
    match res {
        Ok(Some(_)) => done(id, if archive { "archived" } else { "restored" }, "top"),
        Ok(None) => match meta_miss(&state, id).await {
            Ok((archived, _)) if archived == archive => {
                // Someone else already did the same thing: say so plainly.
                done(id, if archive { "already_archived" } else { "already_restored" }, "top")
            }
            Ok(_) => problem(&state, &user, id, StatusCode::CONFLICT, "Someone changed this meeting while you were looking at it. Check it and try again.", None).await,
            Err(e) => ApiError::from(e).into_response(),
        },
        Err(e) => ApiError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct NewNoteForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    submit_key: String,
    #[serde(default)]
    body: String,
}

enum AddOutcome {
    Added(Uuid),
    Duplicate(Uuid),
    Archived,
    Full,
}

/// POST /meetings/{id}/notes
pub async fn add_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path(id): Path<Uuid>,
    Form(f): Form<NewNoteForm>,
) -> Response {
    if let Err(r) = guard(&state, &headers, &user, &f.csrf, id).await {
        return r;
    }
    let body = clean_note(&f.body);
    let draft = || {
        Some(Draft {
            target: DraftTarget::NewNote,
            text: body.clone(),
        })
    };
    let Ok(key) = Uuid::parse_str(&f.submit_key) else {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            "This form is out of date. Your text is kept below; save again.",
            draft(),
        )
        .await;
    };
    if body.trim().is_empty() {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            "Write something before adding a note.",
            None,
        )
        .await;
    }
    if body.chars().count() > MAX_NOTE_CHARS {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("Notes can be at most {MAX_NOTE_CHARS} characters. Split it into two notes."),
            draft(),
        )
        .await;
    }
    let res: sqlx::Result<_> = async {
        let mut tx = state.db.begin().await?;
        ensure_row(&mut *tx, id, &user.tenant_id).await?;
        // Locks out a concurrent archive and makes the note count exact.
        let archived: bool = sqlx::query_scalar(
            "SELECT archived_at IS NOT NULL FROM library_meetings WHERE meeting_id = $1 AND tenant_id = $2 FOR UPDATE",
        )
        .bind(id)
        .bind(&user.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        if archived {
            return Ok(AddOutcome::Archived);
        }
        if let Some(existing) = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM library_notes WHERE meeting_id = $1 AND submit_key = $2",
        )
        .bind(id)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?
        {
            return Ok(AddOutcome::Duplicate(existing));
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM library_notes WHERE meeting_id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_NOTES_PER_MEETING {
            return Ok(AddOutcome::Full);
        }
        let note = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO library_notes (id, meeting_id, tenant_id, body, submit_key, created_by, created_by_name, updated_by, updated_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7)",
        )
        .bind(note)
        .bind(id)
        .bind(&user.tenant_id)
        .bind(&body)
        .bind(key)
        .bind(&user.user_id)
        .bind(&user.name)
        .execute(&mut *tx)
        .await?;
        audit(&mut *tx, &user, id, Some(note), "note_add").await?;
        tx.commit().await?;
        sqlx::Result::Ok(AddOutcome::Added(note))
    }
    .await;
    match res {
        Ok(AddOutcome::Added(n)) | Ok(AddOutcome::Duplicate(n)) => done(id, "note_added", &format!("note-{n}")),
        Ok(AddOutcome::Archived) => problem(&state, &user, id, StatusCode::CONFLICT, "This meeting is archived. Restore it to add notes. Your text is kept below.", draft()).await,
        Ok(AddOutcome::Full) => problem(&state, &user, id, StatusCode::UNPROCESSABLE_ENTITY, &format!("A meeting can have at most {MAX_NOTES_PER_MEETING} notes. Add to an existing note instead."), draft()).await,
        Err(e) => ApiError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct NoteForm {
    #[serde(default)]
    csrf: String,
    #[serde(default)]
    version: i32,
    #[serde(default)]
    body: String,
}

enum ChangeOutcome {
    Changed,
    Stale,
    Gone,
    Archived,
}

async fn change_note(
    state: &AppState,
    user: &WebUser,
    id: Uuid,
    note: Uuid,
    version: i32,
    body: Option<&str>,
) -> sqlx::Result<ChangeOutcome> {
    let mut tx = state.db.begin().await?;
    // Shares the lock an archive takes, so an edit never lands on an archived meeting.
    let archived: Option<bool> = sqlx::query_scalar(
        "SELECT archived_at IS NOT NULL FROM library_meetings WHERE meeting_id = $1 AND tenant_id = $2 FOR SHARE",
    )
    .bind(id)
    .bind(&user.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    if archived == Some(true) {
        return Ok(ChangeOutcome::Archived);
    }
    let hit = match body {
        Some(b) => sqlx::query(
            "UPDATE library_notes SET body = $5, version = version + 1, updated_at = now(), updated_by = $6, updated_by_name = $7
             WHERE id = $1 AND meeting_id = $2 AND tenant_id = $3 AND version = $4",
        )
        .bind(note)
        .bind(id)
        .bind(&user.tenant_id)
        .bind(version)
        .bind(b)
        .bind(&user.user_id)
        .bind(&user.name)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
        None => sqlx::query(
            "DELETE FROM library_notes WHERE id = $1 AND meeting_id = $2 AND tenant_id = $3 AND version = $4",
        )
        .bind(note)
        .bind(id)
        .bind(&user.tenant_id)
        .bind(version)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
    };
    if hit == 0 {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM library_notes WHERE id = $1 AND meeting_id = $2 AND tenant_id = $3)",
        )
        .bind(note)
        .bind(id)
        .bind(&user.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        return Ok(if exists {
            ChangeOutcome::Stale
        } else {
            ChangeOutcome::Gone
        });
    }
    audit(
        &mut *tx,
        user,
        id,
        Some(note),
        if body.is_some() {
            "note_edit"
        } else {
            "note_delete"
        },
    )
    .await?;
    tx.commit().await?;
    Ok(ChangeOutcome::Changed)
}

/// POST /meetings/{id}/notes/{note}
pub async fn edit_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path((id, note)): Path<(Uuid, Uuid)>,
    Form(f): Form<NoteForm>,
) -> Response {
    if let Err(r) = guard(&state, &headers, &user, &f.csrf, id).await {
        return r;
    }
    let body = clean_note(&f.body);
    let draft = |target| {
        Some(Draft {
            target,
            text: body.clone(),
        })
    };
    if body.trim().is_empty() {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            "A note cannot be empty. Use Delete to remove it.",
            draft(DraftTarget::Note(note)),
        )
        .await;
    }
    if body.chars().count() > MAX_NOTE_CHARS {
        return problem(
            &state,
            &user,
            id,
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("Notes can be at most {MAX_NOTE_CHARS} characters."),
            draft(DraftTarget::Note(note)),
        )
        .await;
    }
    match change_note(&state, &user, id, note, f.version, Some(&body)).await {
        Ok(ChangeOutcome::Changed) => done(id, &format!("note_saved&note={note}"), &format!("note-{note}")),
        Ok(ChangeOutcome::Stale) => problem(
            &state, &user, id, StatusCode::CONFLICT,
            "Someone else saved this note while you were editing. Your version is in the form below the current one; save again to replace it, or cancel.",
            draft(DraftTarget::Note(note)),
        ).await,
        Ok(ChangeOutcome::Gone) => problem(
            &state, &user, id, StatusCode::CONFLICT,
            "This note was deleted while you were editing. Your text is kept in the new-note box; add it again if you still need it.",
            draft(DraftTarget::NewNote),
        ).await,
        Ok(ChangeOutcome::Archived) => problem(&state, &user, id, StatusCode::CONFLICT, "This meeting is archived. Restore it to edit notes.", None).await,
        Err(e) => ApiError::from(e).into_response(),
    }
}

/// POST /meetings/{id}/notes/{note}/delete
pub async fn delete_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: WebUser,
    Path((id, note)): Path<(Uuid, Uuid)>,
    Form(f): Form<VersionForm>,
) -> Response {
    if let Err(r) = guard(&state, &headers, &user, &f.csrf, id).await {
        return r;
    }
    match change_note(&state, &user, id, note, f.version, None).await {
        Ok(ChangeOutcome::Changed) => done(id, "note_deleted", "notes"),
        Ok(ChangeOutcome::Gone) => done(id, "note_already_deleted", "notes"),
        Ok(ChangeOutcome::Stale) => problem(
            &state, &user, id, StatusCode::CONFLICT,
            "This note changed since you opened it, so it was not deleted. Read the current text and delete again if you still want to.",
            None,
        ).await,
        Ok(ChangeOutcome::Archived) => problem(&state, &user, id, StatusCode::CONFLICT, "This meeting is archived. Restore it to change notes.", None).await,
        Err(e) => ApiError::from(e).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_one_clean_line() {
        assert_eq!(clean_title("  Weekly \n\t sync\u{0007} "), "Weekly sync");
        assert_eq!(clean_title("   "), "");
    }

    #[test]
    fn notes_keep_lines_but_drop_controls() {
        assert_eq!(clean_note("\n\nA\r\nB\u{0000}\tC   \n\n"), "A\nB\tC");
    }
}

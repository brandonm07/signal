"""Signal Advisory · Streamlit prospecting dashboard.

Interactive UI over the same Researcher → Targeter → Drafter pipeline that
run.py uses. Type a company name, watch progress, see the brief and
drafts rendered with proper markdown.

Launch:
    streamlit run app.py

Codespaces auto-forwards the port and the page opens in a browser tab.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional

import streamlit as st
from dotenv import load_dotenv

from agents.drafter import Drafter
from agents.memory import Memory
from agents.pipeline import PipelineResult, run_brief
from agents.researcher import Researcher
from agents.targeter import Targeter

OUTPUT_DIR = Path("output")
MEMORY_DB = OUTPUT_DIR / "memory.db"

load_dotenv()

st.set_page_config(
    page_title="Signal Advisory · Prospecting",
    page_icon="✦",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Brand polish: pull in Fraunces for headings, tighten the chrome.
st.markdown(
    """
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&display=swap" rel="stylesheet">
    <style>
      .block-container { max-width: 1100px; padding-top: 2rem; }
      h1, h2, h3 { font-family: 'Fraunces', Georgia, serif !important; letter-spacing: -0.01em; }
      h1 { font-weight: 400 !important; }
      .meta { color: #7a7067; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.15em; }
      [data-testid="stSidebar"] { background: #f0ebe0; }
      [data-testid="stSidebar"] h1 { font-size: 1.4rem; margin-bottom: 0; }
      [data-testid="stSidebar"] .stButton button {
        text-align: left;
        justify-content: flex-start;
        background: transparent;
        border: 1px solid rgba(26, 31, 36, 0.1);
        color: #1a1f24;
      }
      [data-testid="stSidebar"] .stButton button:hover { border-color: #c9462c; color: #c9462c; }
    </style>
    """,
    unsafe_allow_html=True,
)


# ---- Agent instantiation (cached so we don't re-init on every rerun) -------


@st.cache_resource
def get_agents() -> tuple[Researcher, Targeter, Drafter, Memory]:
    return Researcher(), Targeter(), Drafter(), Memory(db_path=MEMORY_DB)


# ---- Sidebar: history -------------------------------------------------------


def load_recent_briefs(limit: int = 25) -> list[tuple[str, str, str]]:
    """Return [(company, generated_at, brief_path)] for the sidebar."""
    if not MEMORY_DB.exists():
        return []
    with sqlite3.connect(MEMORY_DB) as conn:
        rows = conn.execute(
            """
            SELECT company, generated_at, brief_path
            FROM briefs
            WHERE status = 'ok' AND brief_path IS NOT NULL
            ORDER BY generated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows if r[2] and Path(r[2]).exists()]


with st.sidebar:
    st.markdown("# Signal Advisory")
    st.caption("Prospecting · internal")

    if st.button("+ New brief", use_container_width=True):
        st.session_state.pop("current", None)
        st.rerun()

    st.divider()
    st.markdown('<p class="meta">Recent briefs</p>', unsafe_allow_html=True)

    recent = load_recent_briefs()
    if not recent:
        st.caption("None yet — generate one to start.")
    for company, generated_at, path in recent:
        date_str = generated_at[:10]
        if st.button(f"{company}\n{date_str}", key=f"hist-{path}", use_container_width=True):
            st.session_state.current = {
                "company": company,
                "path": Path(path),
                "content": Path(path).read_text(encoding="utf-8"),
                "from_cache": True,
            }
            st.rerun()


# ---- Main: form + result viewer --------------------------------------------


def split_into_sections(content: str) -> dict[str, str]:
    """Split rendered markdown on H1 dividers into named sections."""
    sections = {"header": "", "research": "", "contacts": "", "drafts": ""}
    parts = content.split("\n---\n")
    if len(parts) >= 1:
        sections["header"] = parts[0].strip()
    for part in parts[1:]:
        p = part.strip()
        if p.startswith("# Research Brief"):
            sections["research"] = p[len("# Research Brief") :].strip()
        elif p.startswith("# Decision Makers"):
            sections["contacts"] = p[len("# Decision Makers") :].strip()
        elif p.startswith("# Outreach Drafts"):
            sections["drafts"] = p[len("# Outreach Drafts") :].strip()
    return sections


def render_result(result_content: str, header_company: str, source_note: str = "") -> None:
    """Render a brief in three tabs: Research, Decision Makers, Drafts."""
    sections = split_into_sections(result_content)

    st.markdown(f"# {header_company}")
    if source_note:
        st.caption(source_note)

    if sections["header"]:
        # Skip rendering the H1 from the markdown (we already showed company).
        meta_lines = [
            line for line in sections["header"].splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        if meta_lines:
            st.markdown("\n".join(meta_lines))

    tab_research, tab_contacts, tab_drafts = st.tabs(
        ["Research Brief", "Decision Makers", "Outreach Drafts"]
    )
    with tab_research:
        st.markdown(sections["research"] or "_No research available._")
    with tab_contacts:
        st.markdown(sections["contacts"] or "_No contacts identified._")
    with tab_drafts:
        st.markdown(sections["drafts"] or "_No drafts generated._")

    # Raw markdown copy/download convenience.
    with st.expander("Raw markdown"):
        st.code(result_content, language="markdown")


# Show whichever brief is currently active (form just submitted, or sidebar pick).
if "current" in st.session_state:
    cur = st.session_state.current
    note = "Loaded from cache" if cur.get("from_cache") else f"Saved to {cur.get('path', '')}"
    render_result(cur["content"], cur["company"], source_note=note)
    st.divider()


# Generation form.
st.markdown('<p class="meta">Generate</p>', unsafe_allow_html=True)
st.markdown("## Research any company")

with st.form("generate_form", clear_on_submit=False):
    company = st.text_input(
        "Company name",
        placeholder="Cintas Corporation",
        help="Required. The target company you want a brief on.",
    )
    col1, col2 = st.columns(2)
    with col1:
        contact = st.text_input("Contact name (optional)", placeholder="Jane Smith")
    with col2:
        notes = st.text_input("Sales notes (optional)", placeholder="Met at SXSW; SD-WAN renewal Q3")

    refresh = st.checkbox(
        "Force refresh",
        value=False,
        help="Ignore the cached brief if one exists and regenerate from scratch. "
        "Spends OpenRouter credit.",
    )
    submit = st.form_submit_button("Generate brief", type="primary")


def status_writer(box) -> "callable[[str], None]":
    """Map pipeline status codes to friendly progress lines in a status box."""
    labels = {
        "cached": "Found a cached brief — loading.",
        "researching": "Pulling search results, Wikipedia, SEC filings…",
        "targeting": "Identifying decision makers…",
        "drafting": "Writing outreach in your voice…",
        "done": "Done.",
    }

    def write(msg: str) -> None:
        text = labels.get(msg, msg)
        if text:
            box.write(text)

    return write


if submit:
    if not company.strip():
        st.error("Company name is required.")
    else:
        try:
            researcher, targeter, drafter, memory = get_agents()
        except RuntimeError as exc:
            st.error(f"Setup error: {exc}")
            st.stop()

        with st.status(f"Generating brief for **{company.strip()}**…", expanded=True) as box:
            on_status = status_writer(box)
            result: PipelineResult = run_brief(
                company=company.strip(),
                contact_name=(contact or "").strip() or None,
                notes=(notes or "").strip() or None,
                researcher=researcher,
                targeter=targeter,
                drafter=drafter,
                memory=memory,
                output_dir=OUTPUT_DIR,
                refresh=refresh,
                on_status=on_status,
            )
            if result.status == "error":
                box.update(label=f"Failed: {result.error}", state="error")
            elif result.status == "cached":
                box.update(label="Loaded from cache.", state="complete")
            else:
                box.update(label="Brief ready.", state="complete")

        if result.status == "error":
            st.error(result.error)
        else:
            st.session_state.current = {
                "company": result.company,
                "path": result.brief_path,
                "content": result.content,
                "from_cache": result.status == "cached",
            }
            st.rerun()

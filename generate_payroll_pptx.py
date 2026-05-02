"""
Génère un fichier PowerPoint expliquant le mécanisme de paie NexusRH.
Utilise uniquement les modules Python built-in (zipfile).
"""
import zipfile
import io

# Compteur global d'ID de shapes (reset à chaque slide)
_shape_id_counter = [2]  # commence à 2 (1 est réservé au groupe)

def reset_shape_ids():
    _shape_id_counter[0] = 2

def next_shape_id():
    sid = _shape_id_counter[0]
    _shape_id_counter[0] += 1
    return sid

OUTPUT_PATH = "D:/OPENLAB/nexusrh/NexusRH_Mecanisme_Paie.pptx"

# ─── Helpers ─────────────────────────────────────────────────────────────────

def emu(cm: float) -> int:
    """Centimètres → EMU (English Metric Units, 1 cm = 360000 EMU)."""
    return int(cm * 360000)

# Dimensions slide (widescreen 33.87 × 19.05 cm)
W = emu(33.87)
H = emu(19.05)

# Palette de couleurs
C_DARK   = "1E293B"   # Slate 800 (fond titre)
C_INDIGO = "4F46E5"   # Indigo 600 (accent)
C_LIGHT  = "F8FAFC"   # Slate 50  (texte clair)
C_GRAY   = "64748B"   # Slate 500 (texte secondaire)
C_WHITE  = "FFFFFF"
C_BG     = "F1F5F9"   # Slate 100 (fond slides normaux)
C_GREEN  = "16A34A"
C_AMBER  = "D97706"
C_RED    = "DC2626"
C_BLUE   = "2563EB"


# ─── XML fragments ────────────────────────────────────────────────────────────

def solid_fill(color: str) -> str:
    return f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'

def xml_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def text_run(text: str, bold=False, size_pt=18, color=C_DARK, italic=False) -> str:
    b = "<a:b/>" if bold else ""
    i = "<a:i/>" if italic else ""
    sz = size_pt * 100
    return f"""<a:r>
  <a:rPr lang="fr-FR" sz="{sz}" dirty="0">
    {b}{i}
    <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
    <a:latin typeface="Calibri"/>
  </a:rPr>
  <a:t>{xml_escape(text)}</a:t>
</a:r>"""

def paragraph(content: str, align="l", space_before=0, indent=0) -> str:
    spc = f'<a:spcBef><a:spcPts val="{space_before * 100}"/></a:spcBef>' if space_before else ""
    ind = f'marL="{emu(indent)}" indent="-{emu(indent)}"' if indent else ""
    return f"""<a:p>
  <a:pPr algn="{align}" {ind}>
    {spc}
    <a:buNone/>
  </a:pPr>
  {content}
</a:p>"""

def bullet_paragraph(text: str, level=0, size_pt=16, color=C_DARK, bold=False, bullet_char="▸", bullet_color=C_INDIGO) -> str:
    indent_levels = [0.6, 1.4, 2.0]
    indent = indent_levels[min(level, 2)]
    sz = size_pt * 100
    b = "<a:b/>" if bold else ""
    return f"""<a:p>
  <a:pPr marL="{emu(indent)}" indent="-{emu(0.5)}" lvl="{level}">
    <a:spcBef><a:spcPts val="120"/></a:spcBef>
    <a:buFont typeface="Arial"/>
    <a:buClr><a:srgbClr val="{bullet_color}"/></a:buClr>
    <a:buChar char="{xml_escape(bullet_char)}"/>
  </a:pPr>
  <a:r>
    <a:rPr lang="fr-FR" sz="{sz}" dirty="0">
      {b}
      <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
      <a:latin typeface="Calibri"/>
    </a:rPr>
    <a:t>{xml_escape(text)}</a:t>
  </a:r>
</a:p>"""

def text_box(x, y, w, h, paragraphs_xml: str, bg_color=None, border_color=None, vert_anchor="t") -> str:
    sid = next_shape_id()
    fill = f"<a:solidFill><a:srgbClr val=\"{bg_color}\"/></a:solidFill>" if bg_color else "<a:noFill/>"
    border = f"""<a:ln><a:solidFill><a:srgbClr val="{border_color}"/></a:solidFill></a:ln>""" if border_color else "<a:ln><a:noFill/></a:ln>"
    return f"""<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="{sid}" name="box{sid}"/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    {fill}
    {border}
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="square" lIns="{emu(0.25)}" rIns="{emu(0.25)}" tIns="{emu(0.15)}" bIns="{emu(0.15)}" anchor="{vert_anchor}">
      <a:normAutofit/>
    </a:bodyPr>
    <a:lstStyle/>
    {paragraphs_xml}
  </p:txBody>
</p:sp>"""

def arrow_shape(x, y, w, h, color=C_INDIGO) -> str:
    """Flèche vers la droite."""
    sid = next_shape_id()
    return f"""<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="{sid}" name="arrow{sid}"/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>
    <a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
  </p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/></p:txBody>
</p:sp>"""

def build_slide(shapes_xml: str, bg_color=C_BG) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="{bg_color}"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="{W}" cy="{H}"/>
          <a:chOff x="0" y="0"/><a:chExt cx="{W}" cy="{H}"/>
        </a:xfrm>
      </p:grpSpPr>
      {shapes_xml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>"""

def slide_rels(layout_id=1) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
    Target="../slideLayouts/slideLayout{layout_id}.xml"/>
</Relationships>"""

# ─── Section header helper ────────────────────────────────────────────────────

def title_bar(title: str, subtitle: str = "", color=C_INDIGO) -> str:
    """Bande colorée en haut avec titre blanc."""
    shapes = text_box(
        emu(0), emu(0), W, emu(2.8),
        paragraph(text_run(title, bold=True, size_pt=32, color=C_WHITE), align="c") +
        (paragraph(text_run(subtitle, bold=False, size_pt=18, color="CBD5E1"), align="c") if subtitle else ""),
        bg_color=color,
        vert_anchor="ctr"
    )
    return shapes

def section_label(text: str, x_cm, y_cm, w_cm=5.0, h_cm=0.8, color=C_INDIGO) -> str:
    return text_box(
        emu(x_cm), emu(y_cm), emu(w_cm), emu(h_cm),
        paragraph(text_run(text, bold=True, size_pt=11, color=C_WHITE), align="c"),
        bg_color=color,
        vert_anchor="ctr"
    )

def card(x_cm, y_cm, w_cm, h_cm, header: str, body_paragraphs: str, header_color=C_INDIGO) -> str:
    shapes = ""
    # Header card
    shapes += text_box(
        emu(x_cm), emu(y_cm), emu(w_cm), emu(0.9),
        paragraph(text_run(header, bold=True, size_pt=13, color=C_WHITE), align="c"),
        bg_color=header_color,
        vert_anchor="ctr"
    )
    # Body card
    shapes += text_box(
        emu(x_cm), emu(y_cm + 0.9), emu(w_cm), emu(h_cm - 0.9),
        body_paragraphs,
        bg_color=C_WHITE,
        border_color="E2E8F0"
    )
    return shapes


# ═══════════════════════════════════════════════════════════════════════════════
# SLIDES
# ═══════════════════════════════════════════════════════════════════════════════

slides = []

# ─── SLIDE 1 — Page de titre ──────────────────────────────────────────────────
def make_slide1():
    reset_shape_ids()
    shapes = ""
    # Fond foncé complet
    shapes += text_box(0, 0, W, H, "", bg_color=C_DARK)
    # Bande indigo centrale
    shapes += text_box(0, emu(5.5), W, emu(7.5),
        paragraph(text_run("Mécanisme de Paie", bold=True, size_pt=52, color=C_WHITE), align="c") +
        paragraph(text_run("NexusRH — SIRH SaaS Multi-Tenant", bold=False, size_pt=24, color="94A3B8"), align="c") +
        paragraph(text_run("", size_pt=14, color=C_WHITE), align="c") +
        paragraph(text_run("Guide technique complet du moteur de calcul des bulletins", italic=True, size_pt=18, color="CBD5E1"), align="c"),
        bg_color="1E1B4B", vert_anchor="ctr")
    # Ligne décorative
    shapes += text_box(emu(12), emu(14.5), emu(10), emu(0.08), "", bg_color=C_INDIGO)
    # Footer
    shapes += text_box(0, emu(16.5), W, emu(1.2),
        paragraph(text_run("Confidentiel · NexusRH 2024 · Données de démonstration", size_pt=11, color="475569"), align="c"),
        vert_anchor="ctr")
    return build_slide(shapes, bg_color=C_DARK)

slides.append(make_slide1())

# ─── SLIDE 2 — Agenda ─────────────────────────────────────────────────────────
def make_slide2():
    reset_shape_ids()
    shapes = title_bar("Sommaire", "Ce que couvre ce document", color=C_DARK)
    topics = [
        ("1", "Architecture du système de paie", "Entités légales, employés, contrats, règles"),
        ("2", "Les 4 types de rubriques",         "Gains, cotisations salariales/patronales, déductions"),
        ("3", "Système de variables et formules", "BRUT, TRANCHE_A/B, VAR:xxx, safeEval"),
        ("4", "Algorithme du moteur PayrollEngine","buildVariables → evaluateRule → computeTotals"),
        ("5", "Workflow mensuel",                  "Open → Calculating → Review → Closed"),
        ("6", "Exemple concret chiffré",           "Calcul complet pour un employé à 4 900 € brut"),
        ("7", "Checklist mensuelle RH",            "Étapes à suivre chaque mois"),
    ]
    col1_x = 1.2
    col2_x = 17.0
    for i, (num, title, desc) in enumerate(topics):
        y = 3.3 + i * 2.0
        # Numéro
        shapes += text_box(emu(col1_x), emu(y), emu(1.6), emu(1.5),
            paragraph(text_run(num, bold=True, size_pt=28, color=C_WHITE), align="c"),
            bg_color=C_INDIGO, vert_anchor="ctr")
        # Titre
        shapes += text_box(emu(col1_x + 1.9), emu(y), emu(13.0), emu(0.75),
            paragraph(text_run(title, bold=True, size_pt=16, color=C_DARK)),
            bg_color=None)
        # Desc
        shapes += text_box(emu(col1_x + 1.9), emu(y + 0.75), emu(13.0), emu(0.7),
            paragraph(text_run(desc, size_pt=13, color=C_GRAY, italic=True)),
            bg_color=None)
        # Col 2 (miroir)
        if i < len(topics):
            pass  # single column layout
    return build_slide(shapes)

slides.append(make_slide2())

# ─── SLIDE 3 — Architecture ────────────────────────────────────────────────────
def make_slide3():
    reset_shape_ids()
    shapes = title_bar("Architecture du Système de Paie", "Les 6 blocs fondamentaux", color="312E81")

    items = [
        ("Entités Légales",    "Sociétés, établissements,\nSIRET, CCN applicable",        C_INDIGO,  1.0,  3.2),
        ("Employés",           "Données personnelles,\nposte, ancienneté, salaire",        C_BLUE,    7.0,  3.2),
        ("Contrats",           "CDI / CDD, salaire brut,\ntaux ETP, date début/fin",      "0891B2",  13.0, 3.2),
        ("Règles de Paie",     "Rubriques cotisations,\nformules de calcul, ordre",        C_GREEN,   1.0,  9.0),
        ("Éléments Variables", "Heures supp, primes,\nconges payés, IJSS",                C_AMBER,   7.0,  9.0),
        ("Bulletins de Paie",  "Résultat final : net à payer,\ncoût employeur, lignes",    C_RED,     13.0, 9.0),
    ]

    for label, desc, color, x, y in items:
        shapes += text_box(emu(x), emu(y), emu(5.8), emu(1.0),
            paragraph(text_run(label, bold=True, size_pt=15, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        shapes += text_box(emu(x), emu(y + 1.0), emu(5.8), emu(1.8),
            paragraph(text_run(desc, size_pt=13, color=C_DARK), align="c"),
            bg_color=C_WHITE, border_color="E2E8F0", vert_anchor="ctr")

    # Flèches ligne 1
    for ax in [6.9, 12.9]:
        shapes += text_box(emu(ax), emu(3.8), emu(0.7), emu(0.5),
            paragraph(text_run("→", bold=True, size_pt=20, color=C_INDIGO), align="c"))

    # Flèches ligne 2
    for ax in [6.9, 12.9]:
        shapes += text_box(emu(ax), emu(9.6), emu(0.7), emu(0.5),
            paragraph(text_run("→", bold=True, size_pt=20, color=C_GREEN), align="c"))

    # Flèche verticale (règles → bulletins)
    shapes += text_box(emu(3.5), emu(12.0), emu(1.5), emu(0.6),
        paragraph(text_run("↓ calcul", bold=True, size_pt=13, color=C_GRAY), align="c"))

    # Note
    shapes += text_box(emu(1.0), emu(16.5), emu(32.0), emu(1.2),
        paragraph(text_run("PayrollEngine.calculate() orchestre tous ces blocs pour produire le bulletin.", italic=True, size_pt=13, color=C_GRAY)),
        bg_color=None)

    return build_slide(shapes)

slides.append(make_slide3())

# ─── SLIDE 4 — Types de rubriques ─────────────────────────────────────────────
def make_slide4():
    reset_shape_ids()
    shapes = title_bar("Les 4 Types de Rubriques", "Classification de chaque ligne du bulletin", color="065F46")

    cards_data = [
        ("earning",                "Gain",              C_GREEN,   1.0,  3.0,
         ["Rémunération du salarié", "Salaire de base, CP, heures supplémentaires, primes", "S'ajoute au brut", "Exemple : Rubrique 1000 — Salaire de base = BRUT"]),
        ("employee_contribution",  "Cotisation Salarié",C_BLUE,    9.2,  3.0,
         ["Retenue sur le salaire du salarié", "CSG, CRDS, retraite salarié, mutuelle", "Réduit le net à payer", "Exemple : R.4100 — CSG déductible = BRUT * 0.9825 * 0.068"]),
        ("employer_contribution",  "Cotisation Patron", C_AMBER,   1.0,  9.8,
         ["Charge supportée par l'employeur", "Maladie pat., allocations familiales, retraite pat.", "Augmente le coût employeur (hors net)", "Exemple : R.4210 — Maladie emp. = BRUT * 0.07"]),
        ("deduction",              "Déduction",         C_RED,     9.2,  9.8,
         ["Retenue exceptionnelle sur le brut", "IJSS (Indemnités Journalières SS)", "Réduit le brut imposable", "Exemple : R.3000 — IJSS = VAR:IJSS si arrêt maladie"]),
    ]

    for rtype, label, color, x, y, bullets in cards_data:
        shapes += text_box(emu(x), emu(y), emu(7.5), emu(1.0),
            paragraph(text_run(f"{label}  [{rtype}]", bold=True, size_pt=15, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        body = "".join(
            bullet_paragraph(b, level=0, size_pt=14, color=C_DARK, bullet_color=color)
            for b in bullets
        )
        shapes += text_box(emu(x), emu(y + 1.0), emu(7.5), emu(5.5),
            body, bg_color=C_WHITE, border_color="E2E8F0")

    return build_slide(shapes)

slides.append(make_slide4())

# ─── SLIDE 5 — Variables & Formules ───────────────────────────────────────────
def make_slide5():
    reset_shape_ids()
    shapes = title_bar("Système de Variables & Formules", "Comment le moteur évalue chaque rubrique", color="1E3A5F")

    # Colonne 1 : Variables disponibles
    shapes += section_label("Variables automatiques", 1.0, 3.1, w_cm=9.5, color=C_INDIGO)
    vars_data = [
        ("BRUT",          "Salaire brut mensuel du contrat"),
        ("BRUT_PRORATA",  "BRUT × (jours travaillés / jours ouvrés)"),
        ("ETP",           "Équivalent Temps Plein (0.5 à 1.0)"),
        ("PLAFOND_SS",    "Plafond Sécu Sociale mensuel (3 864 €)"),
        ("TRANCHE_A",     "min(BRUT, PLAFOND_SS) — base retraite T1"),
        ("TRANCHE_B",     "BRUT entre PLAFOND_SS et 4×PLAFOND_SS"),
        ("SMIC",          "SMIC mensuel 35h (1 766,92 €)"),
        ("JOURS_ABSENCE", "Nombre de jours d'absence non payée"),
        ("HEURES_SUPP",   "Heures supplémentaires du mois"),
    ]
    body = ""
    for var, desc in vars_data:
        body += bullet_paragraph(f"{var}  —  {desc}", level=0, size_pt=13, color=C_DARK, bullet_color=C_INDIGO)
    shapes += text_box(emu(1.0), emu(4.0), emu(15.5), emu(13.5), body, bg_color=C_WHITE, border_color="E2E8F0")

    # Colonne 2 : Syntaxe formules
    shapes += section_label("Syntaxe des formules", 17.5, 3.1, w_cm=15.0, color="0891B2")

    formulas = [
        ("Expression directe",    "BRUT * 0.9825 * 0.068",          "Évaluée par safeEval"),
        ("Préfixe VAR:",          "VAR:CONGES_PAYES",                "Lit un élément variable"),
        ("Valeur fixe",           "45",                              "Montant forfaitaire (€)"),
        ("Base tranches",         "TRANCHE_A * 0.0690",             "Cotisation T1 plafonnée"),
        ("Tranche B",             "TRANCHE_B * 0.0864",             "AGIRC-ARRCO T2"),
        ("Formule conditionnelle","BRUT_PRORATA",                   "Prorata si absences"),
    ]

    body2 = ""
    for title_f, formula, note in formulas:
        body2 += paragraph(text_run(f"  {title_f}", bold=True, size_pt=13, color=C_DARK))
        body2 += paragraph(text_run(f"     → {formula}", bold=False, size_pt=13, color=C_INDIGO))
        body2 += paragraph(text_run(f"       {note}", italic=True, size_pt=11, color=C_GRAY))

    shapes += text_box(emu(17.5), emu(4.0), emu(15.0), emu(9.5), body2, bg_color=C_WHITE, border_color="E2E8F0")

    # SafeEval warning
    shapes += text_box(emu(17.5), emu(13.7), emu(15.0), emu(3.5),
        paragraph(text_run("Sécurité — safeEval()", bold=True, size_pt=13, color=C_WHITE)) +
        bullet_paragraph("Whitelist stricte : [A-Z0-9_\\s+\\-*/.()] uniquement", size_pt=12, color=C_WHITE, bullet_char="•") +
        bullet_paragraph("Aucun accès aux variables système ou aux APIs", size_pt=12, color=C_WHITE, bullet_char="•") +
        bullet_paragraph("eval() JavaScript with sandboxed variables object", size_pt=12, color=C_WHITE, bullet_char="•"),
        bg_color=C_DARK, border_color=None)

    return build_slide(shapes)

slides.append(make_slide5())

# ─── SLIDE 6 — Algorithme PayrollEngine ───────────────────────────────────────
def make_slide6():
    reset_shape_ids()
    shapes = title_bar("PayrollEngine — Algorithme en 3 Étapes", "Le coeur du calcul des bulletins", color="1E1B4B")

    steps = [
        ("ÉTAPE 1", "buildVariables()", C_INDIGO, [
            "Récupère le contrat de l'employé (salaire brut, ETP, dates)",
            "Calcule BRUT = salaire_brut × ETP",
            "Calcule BRUT_PRORATA si absences dans la période",
            "Détermine TRANCHE_A = min(BRUT, PLAFOND_SS)",
            "Détermine TRANCHE_B = max(0, BRUT - PLAFOND_SS)",
            "Charge les éléments variables du mois (VAR:xxx)",
            "Retourne un objet vars = { BRUT, TRANCHE_A, ... }",
        ]),
        ("ÉTAPE 2", "evaluateRules()", C_BLUE, [
            "Récupère les payroll_rules du tenant (triées par 'order')",
            "Filtre les règles dont ruleApplies = vrai pour l'employé",
            "Pour chaque règle, évalue la formula via safeEval(formula, vars)",
            "Cas VAR:CODE → lecture directe dans les éléments variables",
            "Expose le résultat dans vars pour les règles suivantes",
            "Produit un tableau lines[] : { ruleCode, label, amount, type }",
        ]),
        ("ÉTAPE 3", "computeTotals()", C_GREEN, [
            "grossSalary  = Σ earning (lignes type 'earning')",
            "employeeDeductions = Σ (employee_contribution + deduction)",
            "netBeforeTax = grossSalary + employeeDeductions (montants négatifs)",
            "employerCost = grossSalary + Σ employer_contribution",
            "netPayable   = netBeforeTax (PAS = 0 — via DSN ultérieurement)",
            "Retourne { lines, grossSalary, netPayable, employerCost, workingDays }",
        ]),
    ]

    for i, (step_label, func_name, color, bullets) in enumerate(steps):
        x = 0.8 + i * 11.0
        y = 3.2
        shapes += text_box(emu(x), emu(y), emu(10.5), emu(1.1),
            paragraph(text_run(step_label, bold=True, size_pt=11, color="94A3B8"), align="c") +
            paragraph(text_run(func_name, bold=True, size_pt=18, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")

        body = "".join(bullet_paragraph(b, size_pt=13, color=C_DARK, bullet_color=color) for b in bullets)
        shapes += text_box(emu(x), emu(y + 1.1), emu(10.5), emu(13.0), body, bg_color=C_WHITE, border_color="E2E8F0")

        if i < 2:
            shapes += text_box(emu(x + 10.6), emu(y + 0.3), emu(0.8), emu(0.8),
                paragraph(text_run("→", bold=True, size_pt=28, color=color), align="c"))

    return build_slide(shapes)

slides.append(make_slide6())

# ─── SLIDE 7 — Workflow mensuel ────────────────────────────────────────────────
def make_slide7():
    reset_shape_ids()
    shapes = title_bar("Workflow Mensuel de la Paie", "4 phases - De la creation a la cloture", color="7C2D12")

    phases = [
        ("open",        "1. Ouverture",       C_BLUE,   [
            "Création de la période (mois/année)",
            "Sélection de l'entité légale",
            "Vérification des éléments variables",
            "Saisie des heures supp / primes",
            "Vérification des absences du mois",
        ]),
        ("calculating", "2. Calcul",          C_AMBER,  [
            "POST /payroll/periods/:id/calculate-all",
            "PayrollEngine tourne pour chaque employé",
            "Création / màj des pay_slips",
            "Contrainte UNIQUE (employee_id, period_id)",
            "Durée : ~2-5 sec pour 50 employés",
        ]),
        ("review",      "3. Vérification",    C_INDIGO, [
            "Contrôle des totaux (masse brute, net, coût)",
            "Vérification bulletins individuels",
            "Correction des éléments variables si besoin",
            "Relancer le calcul si nécessaire",
            "Validation manager / DAF",
        ]),
        ("closed",      "4. Clôture",         C_GREEN,  [
            "POST /payroll/periods/:id/close",
            "Statut → 'closed' (irréversible)",
            "Génération PDF de tous les bulletins",
            "Publication aux employés (badge 'Nouveau')",
            "Export SEPA & déclaration DSN",
        ]),
    ]

    for i, (status, label, color, bullets) in enumerate(phases):
        x = 0.8 + i * 8.1
        y = 3.2
        shapes += text_box(emu(x), emu(y), emu(7.7), emu(1.1),
            paragraph(text_run(label, bold=True, size_pt=16, color=C_WHITE), align="c") +
            paragraph(text_run(f"status: '{status}'", bold=False, size_pt=11, color="E2E8F0", italic=True), align="c"),
            bg_color=color, vert_anchor="ctr")
        body = "".join(bullet_paragraph(b, size_pt=13, color=C_DARK, bullet_color=color) for b in bullets)
        shapes += text_box(emu(x), emu(y + 1.1), emu(7.7), emu(9.0), body, bg_color=C_WHITE, border_color="E2E8F0")
        if i < 3:
            shapes += text_box(emu(x + 7.8), emu(y + 0.2), emu(0.9), emu(0.8),
                paragraph(text_run("→", bold=True, size_pt=24, color=color), align="c"))

    # Barre statut en bas
    shapes += text_box(emu(0.8), emu(14.5), emu(32.5), emu(1.0),
        paragraph(
            text_run("⚠ Important : ", bold=True, size_pt=13, color=C_AMBER) +
            text_run("Un période fermée (closed) ne peut plus être modifiée. "
                     "Toujours vérifier les totaux AVANT de cliquer sur Clôturer.", size_pt=13, color=C_DARK)),
        bg_color="FEF9C3", border_color=C_AMBER)

    # Légende DSN
    shapes += text_box(emu(0.8), emu(15.8), emu(32.5), emu(2.0),
        paragraph(text_run("Délais légaux DSN : ", bold=True, size_pt=13, color=C_DARK)) +
        bullet_paragraph("≥ 50 salariés : avant le 5 du mois suivant", size_pt=13, color=C_DARK, bullet_color=C_INDIGO) +
        bullet_paragraph("< 50 salariés : avant le 15 du mois suivant", size_pt=13, color=C_DARK, bullet_color=C_INDIGO),
        bg_color=None)

    return build_slide(shapes)

slides.append(make_slide7())

# ─── SLIDE 8 — Exemple concret ────────────────────────────────────────────────
def make_slide8():
    reset_shape_ids()
    shapes = title_bar("Exemple Concret - Calcul Bulletins", "Employe : Developpeur Senior - Salaire brut : 4 900 EUR", color="1E293B")

    # Colonne gauche : Variables calculées
    shapes += section_label("Variables calculées", 1.0, 3.2, w_cm=10.0, color=C_INDIGO)
    vars_lines = [
        ("BRUT",        "4 900,00 €"),
        ("PLAFOND_SS",  "3 864,00 €"),
        ("TRANCHE_A",   "3 864,00 €   (= min(4900, 3864))"),
        ("TRANCHE_B",   "1 036,00 €   (= 4900 - 3864)"),
        ("ETP",         "1,0          (temps plein)"),
        ("BRUT_PRORATA","4 900,00 €   (0 jour d'absence)"),
    ]
    body = ""
    for var, val in vars_lines:
        body += (
            paragraph(text_run(f"  {var:<16}", bold=True, size_pt=13, color=C_INDIGO)) +
            "" # inline not supported, use separate lines
        )
    body = "".join(
        paragraph(
            text_run(f"  {var:<16}  ", bold=True, size_pt=13, color=C_INDIGO) +
            text_run(val, size_pt=13, color=C_DARK)
        )
        for var, val in vars_lines
    )
    shapes += text_box(emu(1.0), emu(4.1), emu(10.0), emu(6.5), body, bg_color=C_WHITE, border_color="E2E8F0")

    # Rubriques
    shapes += section_label("Lignes du bulletin", 12.0, 3.2, w_cm=20.5, color="065F46")
    rubriques = [
        ("1000", "Salaire de base",          "4 900,00 €",  "",           C_GREEN, "earning"),
        ("4100", "CSG déductible 6.80%",     "",            "-327,35 €",  C_BLUE,  "sal"),
        ("4110", "CSG non déductible 2.40%", "",            "-115,54 €",  C_BLUE,  "sal"),
        ("4120", "CRDS 0.50%",               "",            "-24,07 €",   C_BLUE,  "sal"),
        ("4500", "Retraite base sal. 6.90%", "",            "-266,62 €",  C_BLUE,  "sal"),
        ("4600", "AGIRC-ARRCO T1 3.15%",     "",            "-121,72 €",  C_BLUE,  "sal"),
        ("4620", "AGIRC-ARRCO T2 8.64%",     "",            "-89,51 €",   C_BLUE,  "sal"),
        ("5000", "Mutuelle sal.",             "",            "-45,00 €",   C_BLUE,  "sal"),
        ("",     "NET À PAYER",               "3 910,19 €", "",           C_GREEN, "NET"),
    ]

    col_w = [1.4, 5.5, 3.0, 3.0, 2.5]
    headers = ["Code", "Libellé", "Gain", "Retenue", "Type"]
    row_y = 4.1
    header_x = 12.0
    for ci, (hdr, cw) in enumerate(zip(headers, col_w)):
        cx = header_x + sum(col_w[:ci])
        shapes += text_box(emu(cx), emu(row_y), emu(cw), emu(0.7),
            paragraph(text_run(hdr, bold=True, size_pt=12, color=C_WHITE), align="c"),
            bg_color=C_DARK, vert_anchor="ctr")

    for ri, (code, label, gain, ret, color, type_) in enumerate(rubriques):
        ry = row_y + 0.7 + ri * 0.85
        is_total = type_ == "NET"
        row_bg = "EEF2FF" if is_total else (C_WHITE if ri % 2 == 0 else "F8FAFC")
        row_data = [code, label, gain, ret, type_]
        for ci, (val, cw) in enumerate(zip(row_data, col_w)):
            cx = header_x + sum(col_w[:ci])
            bold_cell = is_total
            col_color = C_GREEN if (is_total and ci in [0,1,2]) else (C_RED if ret and ci == 3 else C_DARK)
            shapes += text_box(emu(cx), emu(ry), emu(cw), emu(0.82),
                paragraph(text_run(val, bold=bold_cell, size_pt=12, color=col_color), align="c" if ci != 1 else "l"),
                bg_color=row_bg, border_color="E2E8F0", vert_anchor="ctr")

    # Totaux résumés
    summary = [
        ("Salaire brut",    "4 900,00 €", C_GREEN),
        ("Cotisations sal.", "−989,81 €", C_RED),
        ("Net à payer",     "3 910,19 €", C_INDIGO),
        ("Coût employeur",  "6 347,29 €", C_AMBER),
    ]
    for si, (label, val, color) in enumerate(summary):
        sx = 1.0 + si * 2.8
        shapes += text_box(emu(sx), emu(11.2), emu(2.5), emu(0.7),
            paragraph(text_run(label, bold=True, size_pt=11, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        shapes += text_box(emu(sx), emu(11.9), emu(2.5), emu(0.9),
            paragraph(text_run(val, bold=True, size_pt=16, color=color), align="c"),
            bg_color=C_WHITE, border_color="E2E8F0", vert_anchor="ctr")

    return build_slide(shapes)

slides.append(make_slide8())

# ─── SLIDE 9 — Checklist mensuelle ────────────────────────────────────────────
def make_slide9():
    reset_shape_ids()
    shapes = title_bar("Checklist Mensuelle RH", "Processus complet en 6 etapes", color="4A1942")

    steps = [
        ("J-5",  "Collecte des éléments variables",
         ["Saisir heures supplémentaires", "Enregistrer primes exceptionnelles", "Valider absences du mois"], C_BLUE),
        ("J-3",  "Contrôle des données employés",
         ["Vérifier nouveaux contrats / sorties", "Màj salaires si avenants signés", "Vérifier taux AT/MP"], C_INDIGO),
        ("J-2",  "Ouverture de la période",
         ["Créer la période (mois/année + entité légale)", "Vérifier règles de paie actives", "Lancer calcul test"], C_AMBER),
        ("J-1",  "Vérification & corrections",
         ["Contrôler totaux (masse brute, net)", "Vérifier bulletins individuels", "Corriger erreurs détectées"], C_ORANGE if 'C_ORANGE' in dir() else "EA580C"),
        ("J0",   "Clôture & publication",
         ["Clôturer la période (irréversible)", "Générer & publier les bulletins PDF", "Notifier les employés"], C_GREEN),
        ("J+1",  "Export & déclarations",
         ["Générer virement SEPA", "Préparer DSN mensuelle", "Archiver les bulletins (50 ans)"], C_RED),
    ]

    for i, (date, title, items, color) in enumerate(steps):
        col = i % 3
        row = i // 3
        x = 1.0 + col * 11.0
        y = 3.2 + row * 7.2
        shapes += text_box(emu(x), emu(y), emu(1.5), emu(5.8),
            paragraph(text_run(date, bold=True, size_pt=16, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        shapes += text_box(emu(x + 1.5), emu(y), emu(9.0), emu(1.1),
            paragraph(text_run(title, bold=True, size_pt=15, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        body = "".join(bullet_paragraph(item, size_pt=13, color=C_DARK, bullet_color=color) for item in items)
        shapes += text_box(emu(x + 1.5), emu(y + 1.1), emu(9.0), emu(4.7), body, bg_color=C_WHITE, border_color="E2E8F0")

    return build_slide(shapes)

slides.append(make_slide9())

# ─── SLIDE 10 — Points clés à retenir ─────────────────────────────────────────
def make_slide10():
    reset_shape_ids()
    shapes = title_bar("Points Cles a Retenir", "Les erreurs frequentes et comment les eviter", color=C_DARK)

    points = [
        ("Formule NOT NULL",        C_RED,    [
            "Chaque rubrique DOIT avoir une formula (même les cotisations à taux)",
            "Format correct : BRUT * 0.9825 * 0.068  (PAS rate: 0.068 seul)",
            "Le moteur évalue formula, pas le champ rate directement",
        ]),
        ("Contrainte UNIQUE",       C_AMBER,  [
            "La table pay_slips nécessite UNIQUE(employee_id, period_id)",
            "Sans cette contrainte, onConflictDoUpdate échoue silencieusement",
            "Vérifier que la contrainte existe dans chaque schema tenant",
        ]),
        ("Période fermée",          C_BLUE,   [
            "Une période 'closed' ne peut plus être recalculée",
            "Toujours rester en 'open' ou 'review' pendant les vérifications",
            "En cas d'erreur : contacter super_admin pour intervention DB",
        ]),
        ("Isolation multi-tenant",  C_GREEN,  [
            "Chaque tenant a son schema PostgreSQL isolé",
            "Toutes les requêtes passent par SET search_path = {schema}",
            "Un tenant ne peut jamais accéder aux données d'un autre tenant",
        ]),
        ("Éléments variables",      C_INDIGO, [
            "Les primes et heures supp sont dans variable_elements",
            "Accessibles via préfixe VAR: dans les formules (ex: VAR:PRIME_EXCEP)",
            "Doivent être saisis AVANT de lancer le calcul de la période",
        ]),
        ("DSN & conformité",        "7C3AED", [
            "DSN à transmettre avant le 5 M+1 (≥50 sal.) ou 15 M+1 (<50)",
            "NIR et IBAN stockés chiffrés AES-256 (obligation RGPD)",
            "Bulletins à conserver 50 ans / dossier RH 5 ans post-départ",
        ]),
    ]

    for i, (title, color, bullets) in enumerate(points):
        col = i % 2
        row = i // 2
        x = 1.0 + col * 16.5
        y = 3.2 + row * 4.9
        shapes += text_box(emu(x), emu(y), emu(15.5), emu(0.9),
            paragraph(text_run(title, bold=True, size_pt=15, color=C_WHITE), align="c"),
            bg_color=color, vert_anchor="ctr")
        body = "".join(bullet_paragraph(b, size_pt=13, color=C_DARK, bullet_color=color) for b in bullets)
        shapes += text_box(emu(x), emu(y + 0.9), emu(15.5), emu(3.9), body, bg_color=C_WHITE, border_color="E2E8F0")

    return build_slide(shapes)

slides.append(make_slide10())


# ═══════════════════════════════════════════════════════════════════════════════
# ASSEMBLY PPTX
# ═══════════════════════════════════════════════════════════════════════════════

N = len(slides)

def content_types(n):
    slide_types = "\n".join(
        f'  <Override PartName="/ppt/slides/slide{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(n)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
{slide_types}
</Types>"""

def package_rels():
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""

def presentation_xml(n):
    slide_ids = "\n".join(
        f'    <p:sldId id="{256+i}" r:id="rId{i+1}"/>'
        for i in range(n)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                saveSubsetFonts="1">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId{n+1}"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
{slide_ids}
  </p:sldIdLst>
  <p:sldSz cx="{W}" cy="{H}" type="custom"/>
  <p:notesSz cx="{W}" cy="{H}"/>
</p:presentation>"""

def presentation_rels(n):
    slide_rels_entries = "\n".join(
        f'  <Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i+1}.xml"/>'
        for i in range(n)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
{slide_rels_entries}
  <Relationship Id="rId{n+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>"""

SLIDE_MASTER = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="F1F5F9"/></a:solidFill>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lstStyle/></p:titleStyle>
    <p:bodyStyle><a:lstStyle/></p:bodyStyle>
    <p:otherStyle><a:lstStyle/></p:otherStyle>
  </p:txStyles>
</p:sldMaster>"""

SLIDE_MASTER_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""

SLIDE_LAYOUT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"""

SLIDE_LAYOUT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""

THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="NexusRH">
  <a:themeElements>
    <a:clrScheme name="NexusRH">
      <a:dk1><a:srgbClr val="1E293B"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="334155"/></a:dk2>
      <a:lt2><a:srgbClr val="F1F5F9"/></a:lt2>
      <a:accent1><a:srgbClr val="4F46E5"/></a:accent1>
      <a:accent2><a:srgbClr val="16A34A"/></a:accent2>
      <a:accent3><a:srgbClr val="D97706"/></a:accent3>
      <a:accent4><a:srgbClr val="DC2626"/></a:accent4>
      <a:accent5><a:srgbClr val="2563EB"/></a:accent5>
      <a:accent6><a:srgbClr val="7C3AED"/></a:accent6>
      <a:hlink><a:srgbClr val="4F46E5"/></a:hlink>
      <a:folHlink><a:srgbClr val="818CF8"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="NexusRH">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>"""


# ─── Écriture du fichier PPTX ─────────────────────────────────────────────────
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("[Content_Types].xml", content_types(N))
    zf.writestr("_rels/.rels", package_rels())
    zf.writestr("ppt/presentation.xml", presentation_xml(N))
    zf.writestr("ppt/_rels/presentation.xml.rels", presentation_rels(N))
    zf.writestr("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER)
    zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS)
    zf.writestr("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT)
    zf.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS)
    zf.writestr("ppt/theme/theme1.xml", THEME)

    for i, slide_xml in enumerate(slides):
        zf.writestr(f"ppt/slides/slide{i+1}.xml", slide_xml)
        zf.writestr(f"ppt/slides/_rels/slide{i+1}.xml.rels", slide_rels())

pptx_bytes = buf.getvalue()
with open(OUTPUT_PATH, "wb") as f:
    f.write(pptx_bytes)

size_kb = len(pptx_bytes) // 1024
import sys
sys.stdout.reconfigure(encoding='utf-8') if hasattr(sys.stdout, 'reconfigure') else None
print("OK Fichier genere : " + OUTPUT_PATH)
print("   Taille : " + str(size_kb) + " Ko, " + str(N) + " slides")

#!/usr/bin/env python3
import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

DEFAULT_CONFIG = {
    "sectionNamePattern": r"^section_notice_(\d+)$",
    "roleAliases": {
        "background": ["background", "bg", "bg-main"],
        "title": ["title", "heading"],
        "body": ["body", "content"],
    },
    "defaults": {
        "layoutKind": "text-in-background-block",
        "responsive": True,
        "fixedWidth": True,
        "backgroundStrategy": "auto",
        "contentDirection": "vertical",
    },
}

CSS_RULE_RE = re.compile(r"(?P<selectors>[^{}]+)\{(?P<body>[^{}]+)\}", re.S)
DECLARATION_RE = re.compile(r"([\w-]+)\s*:\s*([^;]+)")
TRANSLATE_RE = re.compile(r"translate\(([^)]+)\)")
HEX_COLOR_RE = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
URL_FILL_RE = re.compile(r"url\(#([^)]+)\)")


@dataclass
class Issue:
    code: str
    severity: str
    message: str
    role: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
        }
        if self.role:
            data["role"] = self.role
        return data


@dataclass
class ParsedNode:
    element: ET.Element
    tag: str
    name: str | None
    node_id: str | None
    bounds: dict[str, float] | None
    text_content: str | None
    children: list["ParsedNode"]
    style: dict[str, Any]
    transform: dict[str, float] | None


@dataclass
class SectionMatch:
    section_id: str
    source_group: str
    parsed_node: ParsedNode
    order_y: float
    matched_nodes: dict[str, ParsedNode]
    issues: list[Issue]
    status: str


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(config_path: Path | None) -> dict[str, Any]:
    if not config_path:
        return DEFAULT_CONFIG
    try:
        user_config = json.loads(config_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RuntimeError(f"CONFIG_READ_FAILED: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"CONFIG_PARSE_FAILED: {exc}") from exc
    return deep_merge(DEFAULT_CONFIG, user_config)


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def parse_number(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.strip().replace("px", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def normalize_hex(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not HEX_COLOR_RE.match(value):
        return None
    if len(value) == 4:
        return "#" + "".join(ch * 2 for ch in value[1:]).upper()
    return value.upper()


def parse_transform_translate(value: str | None) -> dict[str, float] | None:
    if not value:
        return None
    match = TRANSLATE_RE.search(value)
    if not match:
        return None
    raw = match.group(1).replace(",", " ").split()
    numbers = [parse_number(part) for part in raw]
    numbers = [number for number in numbers if number is not None]
    if not numbers:
        return None
    x = numbers[0]
    y = numbers[1] if len(numbers) > 1 else 0.0
    return {"x": x, "y": y}


def effective_name(element: ET.Element) -> str | None:
    data_name = element.attrib.get("data-name")
    if data_name:
        return data_name.strip()
    node_id = element.attrib.get("id")
    if node_id:
        return node_id.strip()
    return None


def extract_text(element: ET.Element) -> str | None:
    tspans = ["".join(t.itertext()).strip() for t in element if local_name(t.tag) == "tspan"]
    tspans = [text for text in tspans if text]
    if tspans:
        return "\n".join(tspans)
    text = "".join(element.itertext()).strip()
    return text or None


def parse_css_classes(root_element: ET.Element) -> dict[str, dict[str, str]]:
    classes: dict[str, dict[str, str]] = {}
    for style_element in root_element.findall(".//{*}style"):
        style_text = "".join(style_element.itertext())
        for rule_match in CSS_RULE_RE.finditer(style_text):
            selectors = [selector.strip() for selector in rule_match.group("selectors").split(",")]
            declarations = {
                key.strip(): value.strip()
                for key, value in DECLARATION_RE.findall(rule_match.group("body"))
            }
            for selector in selectors:
                if selector.startswith("."):
                    class_name = selector[1:]
                    existing = classes.get(class_name, {})
                    existing.update(declarations)
                    classes[class_name] = existing
    return classes


def parse_gradients(root_element: ET.Element) -> dict[str, dict[str, Any]]:
    gradients: dict[str, dict[str, Any]] = {}
    for gradient in root_element.findall(".//{*}linearGradient"):
        gradient_id = gradient.attrib.get("id")
        if not gradient_id:
            continue
        stops = []
        for stop in gradient.findall("{*}stop"):
            color = normalize_hex(stop.attrib.get("stop-color"))
            if not color:
                continue
            stops.append(
                {
                    "offset": stop.attrib.get("offset", "0"),
                    "color": color,
                }
            )
        gradients[gradient_id] = {
            "type": "linear",
            "x1": parse_number(gradient.attrib.get("x1")),
            "y1": parse_number(gradient.attrib.get("y1")),
            "x2": parse_number(gradient.attrib.get("x2")),
            "y2": parse_number(gradient.attrib.get("y2")),
            "stops": stops,
        }
    return gradients


def element_style(element: ET.Element, css_classes: dict[str, dict[str, str]], gradients: dict[str, dict[str, Any]]) -> dict[str, Any]:
    style: dict[str, Any] = {}
    class_names = element.attrib.get("class", "").split()
    for class_name in class_names:
        style.update(css_classes.get(class_name, {}))

    direct_keys = [
        "fill",
        "stroke",
        "stroke-width",
        "font-size",
        "font-family",
        "font-weight",
        "opacity",
    ]
    for key in direct_keys:
        if key in element.attrib:
            style[key] = element.attrib[key]

    normalized: dict[str, Any] = {}
    fill_value = style.get("fill")
    stroke_value = style.get("stroke")

    if fill_value:
        fill_match = URL_FILL_RE.match(fill_value.strip())
        if fill_match and fill_match.group(1) in gradients:
            gradient_id = fill_match.group(1)
            normalized["fill"] = {
                "type": "gradient-linear",
                "gradientRef": gradient_id,
                **gradients[gradient_id],
            }
        else:
            color = normalize_hex(fill_value)
            if color:
                normalized["fill"] = {"type": "solid", "color": color}

    if stroke_value:
        stroke_color = normalize_hex(stroke_value)
        if stroke_color:
            normalized["stroke"] = {
                "color": stroke_color,
                "weight": parse_number(style.get("stroke-width")) or 1.0,
            }

    if "font-size" in style:
        normalized["fontSize"] = parse_number(style.get("font-size"))
    if "font-family" in style:
        normalized["fontFamily"] = style.get("font-family")
    if "font-weight" in style:
        normalized["fontWeight"] = style.get("font-weight")

    return normalized


def extract_bounds(element: ET.Element, tag: str) -> dict[str, float] | None:
    if tag == "rect":
        x = parse_number(element.attrib.get("x"))
        y = parse_number(element.attrib.get("y"))
        width = parse_number(element.attrib.get("width"))
        height = parse_number(element.attrib.get("height"))
        if None in (x, y, width, height):
            return None
        bounds = {"x": x, "y": y, "width": width, "height": height}
        rx = parse_number(element.attrib.get("rx"))
        ry = parse_number(element.attrib.get("ry"))
        if rx is not None:
            bounds["rx"] = rx
        if ry is not None:
            bounds["ry"] = ry
        return bounds
    if tag == "text":
        transform = parse_transform_translate(element.attrib.get("transform"))
        if transform:
            return {"x": transform["x"], "y": transform["y"]}
        x = parse_number(element.attrib.get("x"))
        y = parse_number(element.attrib.get("y"))
        if x is not None and y is not None:
            return {"x": x, "y": y}
    return None


def parse_tree(element: ET.Element, css_classes: dict[str, dict[str, str]], gradients: dict[str, dict[str, Any]]) -> ParsedNode:
    tag = local_name(element.tag)
    children = [parse_tree(child, css_classes, gradients) for child in list(element) if isinstance(child.tag, str)]
    return ParsedNode(
        element=element,
        tag=tag,
        name=effective_name(element),
        node_id=element.attrib.get("id"),
        bounds=extract_bounds(element, tag),
        text_content=extract_text(element) if tag == "text" else None,
        children=children,
        style=element_style(element, css_classes, gradients),
        transform=parse_transform_translate(element.attrib.get("transform")),
    )


def derive_section_id(group_name: str, pattern: re.Pattern[str]) -> str:
    match = pattern.match(group_name)
    if not match:
        return group_name
    number = match.group(1)
    return f"notice_{int(number):03d}"


def normalize_name(value: str | None) -> str | None:
    return value.strip().lower() if value else None


def node_role(node: ParsedNode, config: dict[str, Any]) -> str | None:
    name = normalize_name(node.name)
    if not name:
        return None
    for role, aliases in config["roleAliases"].items():
        if name in {alias.lower() for alias in aliases}:
            return role
    return None


def find_section_groups(root: ParsedNode, config: dict[str, Any]) -> tuple[list[ParsedNode], list[Issue]]:
    pattern = re.compile(config["sectionNamePattern"])
    issues: list[Issue] = []
    sections: list[ParsedNode] = []

    def walk(node: ParsedNode) -> None:
        if node.tag == "g" and node.name and pattern.match(node.name):
            sections.append(node)
        for child in node.children:
            walk(child)

    walk(root)

    seen_ids: set[str] = set()
    for section in sections:
        section_id = derive_section_id(section.name or "", pattern)
        if section_id in seen_ids:
            issues.append(Issue("DUPLICATE_SECTION_ID", "error", f"重复 sectionId: {section_id}"))
        seen_ids.add(section_id)

    return sections, issues


def match_section(section: ParsedNode, config: dict[str, Any]) -> SectionMatch:
    pattern = re.compile(config["sectionNamePattern"])
    section_id = derive_section_id(section.name or "", pattern)
    issues: list[Issue] = []
    role_candidates: dict[str, list[ParsedNode]] = {"background": [], "title": [], "body": []}

    for child in section.children:
        role = node_role(child, config)
        if role in role_candidates:
            role_candidates[role].append(child)

    matched_nodes: dict[str, ParsedNode] = {}

    for role in ("background", "title", "body"):
        candidates = role_candidates[role]
        if len(candidates) == 1:
            matched_nodes[role] = candidates[0]
        elif len(candidates) > 1:
            issues.append(Issue(f"MULTIPLE_{role.upper()}_CANDIDATES", "error", f"{role} 存在多个候选节点", role))
        elif role == "title":
            issues.append(Issue("TITLE_MISSING", "warn", "未找到 title，按可选字段处理", role))
        else:
            issues.append(Issue(f"{role.upper()}_MISSING", "error", f"未找到 {role} 节点", role))

    background = matched_nodes.get("background")
    body = matched_nodes.get("body")
    title = matched_nodes.get("title")

    if background and background.tag != "rect":
        issues.append(Issue("BACKGROUND_NOT_RECT", "warn", "background 不是 rect，建议人工复核", "background"))
    if body and body.tag != "text":
        issues.append(Issue("TEXT_NOT_PRESERVED", "error", "body 没有保留为 text/tspan，可能已被转成 outlines/path", "body"))
    if title and title.tag != "text":
        issues.append(Issue("TEXT_NOT_PRESERVED", "error", "title 没有保留为 text/tspan，可能已被转成 outlines/path", "title"))
    if body and body.tag == "text" and not body.text_content:
        issues.append(Issue("BODY_TEXT_EMPTY", "error", "body 文本节点为空", "body"))
    if title and title.tag == "text" and not title.text_content:
        issues.append(Issue("TITLE_TEXT_EMPTY", "warn", "title 文本节点为空", "title"))

    status = "ready"
    if any(issue.severity == "error" for issue in issues):
        status = "blocked"
    elif any(issue.severity == "warn" for issue in issues):
        status = "needsReview"

    order_y = background.bounds["y"] if background and background.bounds else 0.0

    return SectionMatch(
        section_id=section_id,
        source_group=section.name or section_id,
        parsed_node=section,
        order_y=order_y,
        matched_nodes=matched_nodes,
        issues=issues,
        status=status,
    )


def parse_view_box(root_element: ET.Element) -> dict[str, float] | None:
    view_box = root_element.attrib.get("viewBox")
    if not view_box:
        return None
    parts = [parse_number(part) for part in view_box.replace(",", " ").split()]
    if len(parts) != 4 or any(part is None for part in parts):
        return None
    x, y, width, height = parts
    return {"x": x, "y": y, "width": width, "height": height}


def background_geometry(node: ParsedNode | None) -> dict[str, Any] | None:
    if not node or not node.bounds:
        return None
    return dict(node.bounds)


def text_geometry(node: ParsedNode | None, background_bounds: dict[str, Any] | None) -> dict[str, Any] | None:
    if not node or node.tag != "text":
        return None
    origin = node.transform or node.bounds
    if not origin:
        return None
    x = origin.get("x", 0.0)
    y = origin.get("y", 0.0)
    font_size = node.style.get("fontSize") or 16.0
    line_count = len(node.text_content.splitlines()) if node.text_content else 1
    line_height = font_size * 1.2
    geometry = {
        "x": x,
        "baselineY": y,
        "y": y - font_size,
        "fontSize": font_size,
        "lineHeight": line_height,
        "lineCount": line_count,
        "height": line_height * line_count,
    }
    if background_bounds:
        left_margin = x - background_bounds["x"]
        width = max(background_bounds["width"] - (left_margin * 2), background_bounds["width"] * 0.4)
        geometry["width"] = width
    return geometry


def build_structure(
    section_matches: list[SectionMatch],
    config: dict[str, Any],
    document_id: str,
    artboard: dict[str, float] | None,
) -> dict[str, Any]:
    sections: list[dict[str, Any]] = []
    for order, section in enumerate(section_matches, start=1):
        if section.status == "blocked":
            continue
        background = section.matched_nodes.get("background")
        title = section.matched_nodes.get("title")
        body = section.matched_nodes.get("body")
        bg_geometry = background_geometry(background)
        width = bg_geometry["width"] if bg_geometry else None

        nodes: dict[str, Any] = {}
        if background:
            nodes["background"] = {
                "sourceName": background.name,
                "role": "background",
                "required": True,
                "geometry": bg_geometry,
                "style": background.style,
            }
        if title:
            nodes["title"] = {
                "sourceName": title.name,
                "role": "text",
                "textRole": "title",
                "required": False,
                "geometry": text_geometry(title, bg_geometry),
                "style": title.style,
            }
        if body:
            nodes["body"] = {
                "sourceName": body.name,
                "role": "text",
                "textRole": "body",
                "required": True,
                "geometry": text_geometry(body, bg_geometry),
                "style": body.style,
            }

        layout = {
            "kind": config["defaults"]["layoutKind"],
            "responsive": config["defaults"]["responsive"],
            "fixedWidth": config["defaults"]["fixedWidth"],
            "backgroundStrategy": config["defaults"]["backgroundStrategy"],
            "contentDirection": config["defaults"]["contentDirection"],
        }
        if width is not None:
            layout["width"] = width

        section_frame = bg_geometry if bg_geometry else None

        sections.append(
            {
                "id": section.section_id,
                "sourceGroup": section.source_group,
                "order": order,
                "layout": layout,
                "frame": section_frame,
                "nodes": nodes,
                "content": {
                    "titleText": title.text_content if title and title.text_content else "",
                    "bodyText": body.text_content if body and body.text_content else "",
                },
            }
        )

    structure = {
        "documentId": document_id,
        "version": 1,
        "sourceFormat": "svg",
        "sections": sections,
    }
    if artboard:
        structure["artboard"] = artboard
    return structure


def build_report(section_matches: list[SectionMatch], document_id: str, global_issues: list[Issue]) -> dict[str, Any]:
    summary = {"totalSections": len(section_matches), "ready": 0, "needsReview": 0, "blocked": 0}
    sections: list[dict[str, Any]] = []

    for section in section_matches:
        summary[section.status] += 1
        sections.append(
            {
                "sectionId": section.section_id,
                "sourceGroup": section.source_group,
                "status": section.status,
                "matchedNodes": {
                    role: {
                        "sourceName": node.name,
                        "sourceNodeId": node.node_id,
                        "tag": node.tag,
                        **({"textPreview": node.text_content[:80]} if node.text_content else {}),
                    }
                    for role, node in section.matched_nodes.items()
                },
                "issues": [issue.to_dict() for issue in section.issues],
            }
        )

    return {
        "documentId": document_id,
        "summary": summary,
        "issues": [issue.to_dict() for issue in global_issues],
        "sections": sections,
    }


def determine_document_id(svg_path: Path) -> str:
    return svg_path.stem.replace(" ", "-") or "svg-document"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True)
    parser.add_argument("--config")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    svg_path = Path(args.svg)
    config_path = Path(args.config) if args.config else None
    out_dir = Path(args.out)

    try:
        svg_text = svg_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"SVG_READ_FAILED: {exc}", file=sys.stderr)
        return 1

    try:
        config = load_config(config_path)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        root_element = ET.fromstring(svg_text)
    except ET.ParseError as exc:
        print(f"SVG_PARSE_FAILED: {exc}", file=sys.stderr)
        return 1

    css_classes = parse_css_classes(root_element)
    gradients = parse_gradients(root_element)
    artboard = parse_view_box(root_element)
    root = parse_tree(root_element, css_classes, gradients)
    section_nodes, global_issues = find_section_groups(root, config)
    section_matches = [match_section(section, config) for section in section_nodes]
    section_matches.sort(key=lambda item: (item.order_y, item.section_id))

    document_id = determine_document_id(svg_path)
    structure = build_structure(section_matches, config, document_id, artboard)
    report = build_report(section_matches, document_id, global_issues)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "structure.json").write_text(json.dumps(structure, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {out_dir / 'structure.json'}")
    print(f"Wrote {out_dir / 'report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

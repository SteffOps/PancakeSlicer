package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type workflowPart struct {
	File     string            `json:"file"`
	Name     string            `json:"name"`
	Settings map[string]string `json:"settings"`
}

type sampleWorkflow struct {
	ID      string            `json:"id"`
	Label   string            `json:"label"`
	Printer string            `json:"printer"`
	Process map[string]string `json:"process"`
	Parts   []workflowPart    `json:"parts"`
}

var workflowPiece = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?i:stl|step|stp|3mf)$`)

func (s *Server) workflowDir() string { return filepath.Join(s.cfg.Resources, "handy_models", "5axis") }

func workflowValues(raw map[string]json.RawMessage) map[string]string {
	values := map[string]string{}
	for key, value := range raw {
		var text string
		if json.Unmarshal(value, &text) != nil {
			text = strings.TrimSpace(string(value))
		}
		values[key] = text
	}
	return values
}

func (s *Server) readWorkflow(path string) (sampleWorkflow, bool) {
	var raw struct {
		Label   string                     `json:"label"`
		Printer string                     `json:"printer"`
		Process map[string]json.RawMessage `json:"process"`
		Parts   []struct {
			File     string                     `json:"file"`
			Name     string                     `json:"name"`
			Settings map[string]json.RawMessage `json:"settings"`
		} `json:"parts"`
	}
	b, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(b, &raw)
	}
	if err != nil || raw.Label == "" || raw.Printer == "" || len(raw.Parts) == 0 {
		log.Printf("sample workflow %s skipped: %v", filepath.Base(path), err)
		return sampleWorkflow{}, false
	}
	flow := sampleWorkflow{ID: strings.TrimSuffix(filepath.Base(path), ".workflow.json"), Label: raw.Label, Printer: raw.Printer, Process: workflowValues(raw.Process)}
	for _, part := range raw.Parts {
		if !workflowPiece.MatchString(part.File) {
			log.Printf("sample workflow %s skipped: piece %q", flow.ID, part.File)
			return sampleWorkflow{}, false
		}
		if _, err := os.Stat(filepath.Join(s.workflowDir(), part.File)); err != nil {
			log.Printf("sample workflow %s skipped: %v", flow.ID, err)
			return sampleWorkflow{}, false
		}
		name := part.Name
		if name == "" {
			name = strings.TrimSuffix(part.File, filepath.Ext(part.File))
		}
		flow.Parts = append(flow.Parts, workflowPart{File: part.File, Name: name, Settings: workflowValues(part.Settings)})
	}
	return flow, true
}

func (s *Server) handyWorkflows(w http.ResponseWriter, r *http.Request) {
	paths, _ := filepath.Glob(filepath.Join(s.workflowDir(), "*.workflow.json"))
	sort.Strings(paths)
	flows := []sampleWorkflow{}
	for _, path := range paths {
		if flow, ok := s.readWorkflow(path); ok {
			flows = append(flows, flow)
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, 200, flows)
}

func (s *Server) handyWorkflowPiece(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !workflowPiece.MatchString(name) {
		fail(w, 404, "unrecognized_built_sample_model")
		return
	}
	serveHandyFile(w, r, filepath.Join(s.workflowDir(), name), name)
}

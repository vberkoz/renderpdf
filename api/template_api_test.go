package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

type memoryTemplateAPIStore struct {
	templates map[string]Template
	shares    map[string]TemplateShare
}

func (store *memoryTemplateAPIStore) GetAccessible(ctx context.Context, requesterID, templateID string) (Template, TemplateShareRole, error) {
	if template, err := store.Get(ctx, requesterID, templateID); err == nil {
		return template, TemplateShareRoleOwner, nil
	}
	for _, share := range store.shares {
		if share.RecipientID == requesterID && share.TemplateID == templateID {
			template, err := store.Get(ctx, share.OwnerID, templateID)
			return template, share.Role, err
		}
	}
	return Template{}, "", errTemplateNotFound
}

func (store *memoryTemplateAPIStore) ListShared(ctx context.Context, recipientID string) ([]SharedTemplate, error) {
	result := []SharedTemplate{}
	for _, share := range store.shares {
		if share.RecipientID == recipientID {
			template, err := store.Get(ctx, share.OwnerID, share.TemplateID)
			if err == nil {
				result = append(result, SharedTemplate{Template: template, Access: share.Role})
			}
		}
	}
	return result, nil
}

func shareMemoryKey(ownerID, templateID, recipientID string) string {
	return ownerID + "/" + templateID + "/" + recipientID
}
func (store *memoryTemplateAPIStore) CreateShare(_ context.Context, share TemplateShare) error {
	if err := validateTemplateShare(share); err != nil {
		return err
	}
	if store.shares == nil {
		store.shares = map[string]TemplateShare{}
	}
	key := shareMemoryKey(share.OwnerID, share.TemplateID, share.RecipientID)
	if _, exists := store.shares[key]; exists {
		return errTemplateShareExists
	}
	store.shares[key] = share
	return nil
}
func (store *memoryTemplateAPIStore) ListShares(_ context.Context, ownerID, templateID string) ([]TemplateShare, error) {
	result := []TemplateShare{}
	for _, share := range store.shares {
		if share.OwnerID == ownerID && share.TemplateID == templateID {
			result = append(result, share)
		}
	}
	return result, nil
}
func (store *memoryTemplateAPIStore) UpdateShare(_ context.Context, share TemplateShare) error {
	key := shareMemoryKey(share.OwnerID, share.TemplateID, share.RecipientID)
	existing, ok := store.shares[key]
	if !ok {
		return errTemplateShareNotFound
	}
	share.CreatedAt = existing.CreatedAt
	store.shares[key] = share
	return nil
}
func (store *memoryTemplateAPIStore) DeleteShare(_ context.Context, ownerID, templateID, recipientID string) error {
	key := shareMemoryKey(ownerID, templateID, recipientID)
	if _, ok := store.shares[key]; !ok {
		return errTemplateShareNotFound
	}
	delete(store.shares, key)
	return nil
}

func (store *memoryTemplateAPIStore) Create(_ context.Context, template Template) error {
	if err := validateTemplateForStorage(template); err != nil {
		return err
	}
	if store.templates == nil {
		store.templates = map[string]Template{}
	}
	store.templates[template.OwnerID+"/"+template.ID] = template
	return nil
}

func (store *memoryTemplateAPIStore) Get(_ context.Context, ownerID, templateID string) (Template, error) {
	template, ok := store.templates[ownerID+"/"+templateID]
	if !ok {
		return Template{}, errTemplateNotFound
	}
	return template, nil
}

func (store *memoryTemplateAPIStore) List(_ context.Context, ownerID string) ([]Template, error) {
	templates := []Template{}
	for _, template := range store.templates {
		if template.OwnerID == ownerID {
			templates = append(templates, template)
		}
	}
	return templates, nil
}

func (store *memoryTemplateAPIStore) Update(_ context.Context, template Template) error {
	if _, ok := store.templates[template.OwnerID+"/"+template.ID]; !ok {
		return errTemplateNotFound
	}
	store.templates[template.OwnerID+"/"+template.ID] = template
	return nil
}

func (store *memoryTemplateAPIStore) Delete(_ context.Context, ownerID, templateID string) error {
	key := ownerID + "/" + templateID
	if _, ok := store.templates[key]; !ok {
		return errTemplateNotFound
	}
	delete(store.templates, key)
	return nil
}

func templateAPIRequest(method, ownerID, path, body string) events.APIGatewayProxyRequest {
	request := events.APIGatewayProxyRequest{HTTPMethod: method, Path: path, Body: body}
	if ownerID != "" {
		request.RequestContext.Authorizer = map[string]interface{}{"userId": ownerID}
	}
	return request
}

func TestTemplateCRUDRequiresAuthenticationAndValidInput(t *testing.T) {
	store := &memoryTemplateAPIStore{}
	response := handleTemplateRequest(context.Background(), templateAPIRequest("POST", "", templateResource, `{}`), nil, store)
	if response.StatusCode != 401 {
		t.Fatalf("unauthenticated status = %d, want 401", response.StatusCode)
	}

	response = handleTemplateRequest(context.Background(), templateAPIRequest("POST", "customer-a", templateResource, `{"type":"invoice","html":"<p>Hi</p>"}`), nil, store)
	if response.StatusCode != 422 {
		t.Fatalf("invalid input status = %d, want 422", response.StatusCode)
	}
}

func TestTemplateCRUDUsesOwnerScopeAndExpectedStatuses(t *testing.T) {
	store := &memoryTemplateAPIStore{}
	create := handleTemplateRequest(context.Background(), templateAPIRequest("POST", "customer-a", templateResource, `{"name":"Invoice","type":"invoice","html":"<p>{{customer.name}}</p>"}`), nil, store)
	if create.StatusCode != 201 {
		t.Fatalf("create status = %d, want 201: %s", create.StatusCode, create.Body)
	}
	var created Template
	if err := json.Unmarshal([]byte(create.Body), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	list := handleTemplateRequest(context.Background(), templateAPIRequest("GET", "customer-a", templateResource, ""), nil, store)
	if list.StatusCode != 200 {
		t.Fatalf("list status = %d, want 200", list.StatusCode)
	}
	var listed templateListResponse
	if err := json.Unmarshal([]byte(list.Body), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(listed.Starters) != 4 {
		t.Fatalf("starter count = %d, want 4", len(listed.Starters))
	}
	crossCustomer := handleTemplateRequest(context.Background(), templateAPIRequest("GET", "customer-b", templateResource+"/"+created.ID, ""), nil, store)
	if crossCustomer.StatusCode != 404 {
		t.Fatalf("cross-customer status = %d, want 404", crossCustomer.StatusCode)
	}

	update := handleTemplateRequest(context.Background(), templateAPIRequest("PUT", "customer-a", templateResource+"/"+created.ID, `{"name":"Updated invoice","type":"invoice","html":"<p>Updated</p>"}`), nil, store)
	if update.StatusCode != 200 {
		t.Fatalf("update status = %d, want 200: %s", update.StatusCode, update.Body)
	}
	remove := handleTemplateRequest(context.Background(), templateAPIRequest("DELETE", "customer-a", templateResource+"/"+created.ID, ""), nil, store)
	if remove.StatusCode != 204 {
		t.Fatalf("delete status = %d, want 204", remove.StatusCode)
	}
	missing := handleTemplateRequest(context.Background(), templateAPIRequest("GET", "customer-a", templateResource+"/"+created.ID, ""), nil, store)
	if missing.StatusCode != 404 {
		t.Fatalf("missing status = %d, want 404", missing.StatusCode)
	}
}

func TestRenderTemplatePDFAppliesNestedEscapedValues(t *testing.T) {
	store := &memoryTemplateAPIStore{}
	template := testTemplate("customer-a", "invoice-1")
	template.HTML = `<h1>{{invoice.number}}</h1><p>{{customer.name}}</p>`
	if err := store.Create(context.Background(), template); err != nil {
		t.Fatalf("create template: %v", err)
	}
	var renderedHTML string
	pdf, err := renderTemplatePDF(context.Background(), store, "customer-a", `{"templateId":"invoice-1","variables":{"invoice":{"number":"INV-1042"},"customer":{"name":"Ada & Sons"}}}`, func(_ context.Context, html string) ([]byte, error) {
		renderedHTML = html
		return []byte("PDF:" + html), nil
	})
	if err != nil {
		t.Fatalf("render template PDF: %v", err)
	}
	if !strings.Contains(renderedHTML, "INV-1042") || !strings.Contains(renderedHTML, "Ada &amp; Sons") {
		t.Fatalf("rendered HTML did not contain substituted values: %s", renderedHTML)
	}
	if !strings.Contains(string(pdf), "Ada &amp; Sons") {
		t.Fatalf("PDF bytes did not contain the escaped customer value: %s", pdf)
	}
}

func TestTemplateSharingEnforcesRolesAndRevocation(t *testing.T) {
	store := &memoryTemplateAPIStore{}
	created := handleTemplateRequest(context.Background(), templateAPIRequest("POST", "owner", templateResource, `{"name":"Invoice","type":"invoice","html":"<p>{{customer.name}}</p>"}`), nil, store)
	var template Template
	if err := json.Unmarshal([]byte(created.Body), &template); err != nil {
		t.Fatal(err)
	}
	share := handleTemplateRequest(context.Background(), templateAPIRequest("POST", "owner", templateResource+"/"+template.ID+"/shares", `{"recipientId":"viewer","role":"viewer"}`), nil, store)
	if share.StatusCode != 201 {
		t.Fatalf("share status = %d: %s", share.StatusCode, share.Body)
	}
	if html, _, err := resolveTemplateRenderHTML(context.Background(), store, "viewer", `{"templateId":"`+template.ID+`","variables":{"customer":{"name":"Ada"}}}`); err != nil || !strings.Contains(html, "Ada") {
		t.Fatalf("shared render = %q, %v", html, err)
	}
	shared := handleTemplateRequest(context.Background(), templateAPIRequest("GET", "viewer", templateResource+"/shared", ""), nil, store)
	if shared.StatusCode != 200 || !strings.Contains(shared.Body, template.ID) {
		t.Fatalf("shared list = %d %s", shared.StatusCode, shared.Body)
	}
	view := handleTemplateRequest(context.Background(), templateAPIRequest("GET", "viewer", templateResource+"/"+template.ID, ""), nil, store)
	if view.StatusCode != 200 {
		t.Fatalf("shared get = %d", view.StatusCode)
	}
	edit := handleTemplateRequest(context.Background(), templateAPIRequest("PUT", "viewer", templateResource+"/"+template.ID, `{"name":"Edited","type":"invoice","html":"<p>Edited</p>"}`), nil, store)
	if edit.StatusCode != 404 {
		t.Fatalf("viewer edit = %d, want 404", edit.StatusCode)
	}
	update := handleTemplateRequest(context.Background(), templateAPIRequest("PUT", "owner", templateResource+"/"+template.ID+"/shares/viewer", `{"role":"editor"}`), nil, store)
	if update.StatusCode != 200 {
		t.Fatalf("share update = %d: %s", update.StatusCode, update.Body)
	}
	edit = handleTemplateRequest(context.Background(), templateAPIRequest("PUT", "viewer", templateResource+"/"+template.ID, `{"name":"Edited","type":"invoice","html":"<p>Edited</p>"}`), nil, store)
	if edit.StatusCode != 200 {
		t.Fatalf("editor edit = %d: %s", edit.StatusCode, edit.Body)
	}
	revoke := handleTemplateRequest(context.Background(), templateAPIRequest("DELETE", "owner", templateResource+"/"+template.ID+"/shares/viewer", ""), nil, store)
	if revoke.StatusCode != 204 {
		t.Fatalf("revoke = %d", revoke.StatusCode)
	}
	view = handleTemplateRequest(context.Background(), templateAPIRequest("GET", "viewer", templateResource+"/"+template.ID, ""), nil, store)
	if view.StatusCode != 404 {
		t.Fatalf("revoked get = %d", view.StatusCode)
	}
	if _, _, err := resolveTemplateRenderHTML(context.Background(), store, "viewer", `{"templateId":"`+template.ID+`","variables":{}}`); !errors.Is(err, errTemplateNotFound) {
		t.Fatalf("revoked render error = %v, want not found", err)
	}
}

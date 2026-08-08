package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

type memoryTemplateAPIStore struct {
	templates map[string]Template
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

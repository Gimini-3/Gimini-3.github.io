---
title: "[ONECO DDD 도메인 설계 시리즈 Part 4]  왜 DailyContent → News/Quiz(Entity)는 단방향으로만 묶었을까?
date: 2025-12-17 13:57:00 +0900
tags:
  - DDD
  - domain-driven design
  - domain design
  - architecture
  - aggregate
  - domain model
  - entity
  - value object
thumbnail: "/assets/img/thumbnail/oneco-ddd-dailycontent.png"
---

# [ONECO DDD 도메인 설계 시리즈 Part 4] 왜 DailyContent → News/Quiz(Entity)는 단방향으로만 묶었을까?

## 0. 이 글에서 이야기할 것

oneco 콘텐츠의 도메인은 이렇게 생겼다.

- 하루 단위 묶음: `DailyContent` (애그리거트 루트)
- 그날 보여줄 뉴스들: `NewsItem` (엔티티 리스트)
- 그날 풀게 될 퀴즈들: `Quiz` (엔티티 리스트)

### 도메인 구조


이번 글에서 이야기할 주제는 다음과 같다.

> “왜 DailyContent → News/Quiz 단방향만 만들고,
NewsItem/Quiz → DailyContent 역방향은 안 만들었을까?”
>

이 글에서는:

- 지금 코드에서 `DailyContent`가 자식들을 **어떻게 보호하고 검증하는지**
- “만약 양방향으로 짰다면 코드가 어떻게 달라졌을지”
- JPA + DDD 관점에서 단방향 / 양방향 각각의 **현실적인 장단점**
- 나중에 단방향이 막혀서 역방향이 필요해졌을 때 **어떻게 확장할 계획인지**

까지, 실제 코드를 기준으로 풀어본다.

---

## 1. 현재 설계: DailyContent 가 자식들을 품고 지키는 구조

먼저 `DailyContent`의 핵심 부분이다.

```java
@Entity
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@Table(name = "daily_contents",
	uniqueConstraints = {
		@UniqueConstraint(
			name= "uk_category_day_sequence",
			columnNames = {"category_id", "day_sequence"}
		)
	})
public class DailyContent {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@Embedded
	private CategoryId categoryId;

	@Convert(converter = DaySequenceConverter.class)
	private DaySequence daySequence;

	@Embedded
	private ContentDescription description;

	@Embedded
	private Keyword keyword;

	@Embedded
	@AttributeOverride(name = "url", column = @Column(name = "image_url", nullable = false))
	private ImageFile imageFile;

	@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
	@JoinColumn(name = "daily_content_id", nullable = false)
	private List<NewsItem> newsItems = new ArrayList<>();

	@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
	@JoinColumn(name = "daily_content_id", nullable = false)
	private List<Quiz> quizzes = new ArrayList<>();

	// ...
}

```

여기서 중요한 점은:

- 루트가 자식 리스트를 직접 들고 있다.
- `NewsItem`, `Quiz` 안에는 `DailyContent` 필드가 없다.

  → 자식 입장에서는 부모가 누군지를 모른다.

- FK(`daily_content_id` )는 자식 테이블에 있지만,

  자바 코드는 루트 → 자식 한 방향으로만 향해 있다.


그리고 컬렉션 getter도 이렇게 막아놨다.

```java
public List<NewsItem> getNewsItems() {
	return List.copyOf(newsItems);
}

public List<Quiz> getQuizzes() {
	return List.copyOf(quizzes);
}
```

- `List.copyOf(...)`를 쓰기 때문에,

  `getNewsItems().add(...)`, `getQuizzes().remove(...)` 같은 시도는 바로 예외가 터진다.

- 즉, 루트를 안 거치고 자식 컬렉션을 건드릴 수 있는 경로를 막았다.

자식 추가는 전부 루트 메서드를 통해서만 가능하다.

```java
public NewsItem addNewsItem(
	String title,
	NewsItemOrder order,
	WebLink link,
	ImageFile imageFile
) {
	Objects.requireNonNull(title, "title은 null일 수 없다.");
	Objects.requireNonNull(order, "order는 null일 수 없다.");
	Objects.requireNonNull(imageFile, "imageFile은 null일 수 없다.");
	Objects.requireNonNull(link, "link는 null일 수 없다.");

	validateNewsOrderDuplicate(order); // 순번 중복 방지

	NewsItem item = NewsItem.create(title, link, order, imageFile);
	newsItems.add(item);
	return item;
}

public Quiz addQuiz(
	String question,
	QuestionOrder order,
	QuizOptions options,
	AnswerIndex answerIndex
) {
	Objects.requireNonNull(question, "question은 null일 수 없다.");
	Objects.requireNonNull(order, "order는 null일 수 없다.");
	Objects.requireNonNull(options, "options는 null일 수 없다.");
	Objects.requireNonNull(answerIndex, "answerIndex는 null일 수 없다.");

	validateQuizOrderDuplicate(order); // 순번 중복 방지

	Quiz quiz = Quiz.create(question, order, options, answerIndex);
	quizzes.add(quiz);
	return quiz;
}
```

이 구조는

“뉴스와 퀴즈는 항상 DailyContent를 통해서만 만들어지고, 항상 DailyContent 안에서만 관리된다.”

이게 이번 프로젝트에서 애그리거트를 설계할 세운 원칙이다.

---

### 2. 왜 단방향으로 시작했나? (DDD 관점에서)

### 2.1 애그리거트 루트에 규칙을 모으고 싶었다.

oneco의 도메인 요구사항은 다음과 같다.

- 사용자가 카테고리를 선택하면
- “하루에 하나의 키워드 + 뉴스 여러 개 + 퀴즈 여러 개”를 본다.
- 이는 “하루치 학습 경험” 단위로 관리하고 싶다.

그래서 나는 “하루치”를 애그리거트로 보고, 그 루트를 `DailyContent`로 잡았다.

그럼 “규칙”도 여기에 모아서 관리할 수 있다.

예를 들면:

- 같은 카테고리 + 같은 일차(`DaySequence`)는 하나만 존재해야 한다.
- 한 DailyContent 안에서 뉴스 순번(`NewsItemOrder`)은 중복되면 안 된다.
- 퀴즈 순번(`QuestionOrder`)도 중복되면 안 된다.

이런 검증 로직이 실제로 `DailyContent` 안에 들어가 있다.

```java
private void validateNewsOrderDuplicate(NewsItemOrder order) {
	if (newsItems.stream().anyMatch(n -> n.getNewsItemOrder().equals(order))) {
		throw new IllegalArgumentException("동일한 뉴스 순번이 이미 존재합니다: " + order.value());
	}
}

private void validateQuizOrderDuplicate(QuestionOrder order) {
	if (quizzes.stream().anyMatch(q -> q.getQuestionOrder().equals(order))) {
		throw new IllegalArgumentException("동일한 퀴즈 순번이 이미 존재합니다: " + order.value());
	}
}

```

만약 NewsItem/Quiz에서 DailyContent를 알고 있으면 어떻게 될까?

- 외부에서 `newsItemRepository.save(...)` 같은 걸로 자식만 따로 생성하고
- `NewsItem` 안에서도 `getDailyContent().getQuizzes()...`를 건드릴 수 있게 된다.

이렇게 “루트 바깥에서 자식이 따로 움직이는 경로”가 늘어난다.

DDD에서는 이걸 피하고 싶었다.

그래서 애초에 **방향 자체를 끊어버렸다.**

- 루트 → 자식: OK (루트가 관리)
- 자식 → 루트: 막자 (도메인 경계가 흐려진다)

### 2.2 컬렉션을 “읽기 전용 뷰”로 노출할 수 있었다

`getNewsItems()`, `getQuizzes()`에서 `List.copyOf(...)`를 반환하는 것도 단방향 설계와 잘 맞는다.

- 외부 코드는 이 리스트를 **조회 용도로만** 사용할 수 있다.
- 쓰기는 항상 루트 메서드(`addNewsItem`, `removeNewsItem`, `addQuiz`, `removeQuiz...`)로 통일된다.

이 구조를 지키면, 팀원들과의 규칙이 명확하다.

- “뉴스 추가하고 싶으면 무조건 `DailyContent.addNewsItem`을 호출해야 한다.”
- “퀴즈 삭제하고 싶으면 `removeQuizByOrder`를 써야 한다.”

즉, **조작 전용 API가 루트에만 있다**는 사실을 코드 레벨에서 표현할 수 있다.

### 2.3 직렬화·디버깅이 단순해진다

양방향 관계를 만들면:

- `DailyContent` → `NewsItem`
- `NewsItem` → `DailyContent`

이렇게 서로를 가리키게 된다.

그러면 Jackson 같은 JSON 라이브러리에서 순환 참조 문제가 바로 생긴다.

- `DailyContent` 직렬화

  → `newsItems` 직렬화

  → 각 `NewsItem`의 `dailyContent` 직렬화

  → 다시 `newsItems`… (무한 루프)


물론 `@JsonIgnore`, `@JsonManagedReference`/`@JsonBackReference` 같은 걸로 처리할 수 있다.

근데 그 순간부터 **도메인 모델이 JSON 표현을 신경 쓰게 되는** 오염이 생긴다.

단방향 구조에서는 이 걱정을 거의 안 해도 된다.

- 루트에서 자식 방향만 있어서,
- 직렬화도 “하나의 트리”처럼 잘려 나간다.

---

## 3. 만약 양방향으로 설계했으면?

사실 난 처음에 설계했을 때는 양방향으로 설계하였다.

처음 설계 코드로 분석해보겠다.

- DailyContent(부모)
    - “내 뉴스 목록”을 들고 있음 (부모 → 자식)
- NewsItem(자식)
    - “내가 속한 DailyContent”를 들고 있음 (자식 → 부모)

여기서 **진짜 중요한 포인트는 FK가 어디에 있냐**다.

DB 관점에서 “뉴스가 어느 콘텐츠에 속하는지”는 보통 이렇게 저장된다.

- `news_items.daily_content_id` (FK) ← 이 컬럼이 관계를 기록함

즉, **관계(연결) 정보를 적는 칸이 NewsItem 쪽(자식 테이블)에 있다.**

그래서 JPA도 **“FK를 관리하는 담당자(주인)는 NewsItem 쪽”**이 되는 게 자연스럽다고 판단다.

그리고 그걸 DailyContent 쪽에서 선언하는 게 바로 `mappedBy`.

- `mappedBy = "dailyContent"` 뜻

  → 즉, DailyContent.newsItems는 관계를 ‘저장’하는 담당자가 아니고, **NewsItem 안의 dailyContent 필드가 담당자(주인)** 이다.


---

양방향 매핑

```java
@Entity
public class DailyContent {

	@OneToMany(
		mappedBy = "dailyContent",
		cascade = CascadeType.ALL,
		orphanRemoval = true
	)
	private List<NewsItem> newsItems = new ArrayList<>();

	public void addNewsItem(NewsItem item) {
		newsItems.add(item);
		item.setDailyContent(this); // FK 담당자도 같이 세팅 (양방향 동기화)
	}

	public void removeNewsItem(NewsItem item) {
		newsItems.remove(item);
		item.setDailyContent(null); // FK 끊기(양방향 동기화)
	}
}

```

```java
@Entity
public class NewsItem {

	@ManyToOne(fetch = FetchType.LAZY)
	@JoinColumn(name = "daily_content_id", nullable = false)
	private DailyContent dailyContent;

	public void setDailyContent(DailyContent dailyContent) {
		this.dailyContent = dailyContent;
	}

	// ...
}

```

즉 mappedBy는 이 목록은 내가 관리하는 FK가 아니라, 저쪽(NewsItem.dailyContent)이 관리한다는 의미이다.

### 3.1 이러면 좋은 점

1. **자식에서 부모로 바로 올라갈 수 있다.**

```java
NewsItem news = newsItemRepository.findById(id).orElseThrow();
String keyword = news.getDailyContent().getKeyword().getValue();

```

- 뉴스 기준의 API에서 상위 DailyContent 정보를 끌어오는 시나리오가 많다면 편하다.
1. 뉴스 중심 쿼리가 자연스럽다.

예를 들어:

- “특정 DailyContent에 속한 뉴스만 페이징”
- “뉴스를 기준으로 상위 DailyContent의 일차/카테고리 조회”

같은 걸 JPQL로 쉽게 쓸 수 있다.

```java
@Query("""
	select n
	from NewsItem n
	join fetch n.dailyContent dc
	where dc.id = :dailyContentId
""")
List<NewsItem> findByDailyContentId(Long dailyContentId);
```

단방향(부모만 `newsItems` 들고 있고, 자식에 `dailyContent` 필드가 없으면)에서는 JPQL에서 `n.dailyContent` 경로 자체가 없어서 이런 식으로 못 쓴다.

1. **DB FK 구조와 자바 모델이 더 직관적으로 매칭된다.**

DB에서 FK는 어차피 `news_items.daily_content_id`에 있고,

코드에서도 “뉴스가 부모를 가진다(NewsItem.dailyContent)”가 그대로 드러나니까 이해가 쉽다.

---

### 3.2 하지만 단점도 정확히 존재한다

1. 양방향 동기화를 직접 책임져야 한다 (mappedBy의 핵심 부작용)

   `mappedBy`가 붙은 DailyContent.newsItems는 **FK 담당자(주인)가 아니다.**

   즉, 아래처럼 “목록만 추가”하면 위험하다.

    ```java
    dailyContent.getNewsItems().add(newsItem);   // ❌ 목록만 바꿈
    // newsItem.setDailyContent(dailyContent);    // 이걸 안 하면 FK 담당자는 그대로 null
    ```

   이러면 “메모리 목록”에는 들어간 것처럼 보이는데,

   DB에 저장될 때 FK가 안 세팅돼서 관계가 누락되거나(혹은 nullable=false면 오류)

   영속성 컨텍스트 상태가 꼬이는 문제가 생길 수 있다.

   그래서 내가 쓴 것처럼 **add/remove에서 항상 양쪽을 같이 맞추는 게 필수**다.

2. **도메인 경계가 느슨해진다.**

`NewsItem` 안에서 `getDailyContent()`를 할 수 있으니,

외부 코드가 이런 식으로 쓸 수도 있다.

```java
newsItem.getDailyContent()
	.getQuizzes()
	.add(Quiz.create(...));
```

- 이게 가능해지는 순간,

  “퀴즈 추가는 무조건 `DailyContent.addQuiz`를 통해서만 한다”는 규칙이 깨진다.

- 루트가 책임져야 할 규칙이 여기저기서 우회될 수 있다.
1. **직렬화, toString, equals/hashCode에서 순환 참조 지뢰밭**
- 양방향은 “부모가 자식을 들고, 자식이 부모를 들고”라서
  JSON 직렬화나 toString, equals/hashCode에서 무한 루프가 나기 쉽다.
- 특히 엔티티에 `@EqualsAndHashCode`, `@ToString`을 잘못 붙이면
  StackOverflowError가 터지는 전형적인 패턴이 된다.

---

## 4. 내가 단방향을 선택한 이유

마지막으로, 설계 당시의 내 사고 흐름을 정리하면 이렇다.

1. **가장 먼저 중요했던 건 “방향성”이 아니라 “경계”였다.**
    - 이 도메인에서 핵심 단위는 “하루치 학습 경험”이다.
    - 그래서 DailyContent를 애그리거트 루트로 세우고,

      그 안에 뉴스/퀴즈를 “포함 관계”로 묶는 게 1순위였다.

2. **루트에 규칙을 모으고, 자식은 최대한 단순하게 두고 싶었다.**
    - 뉴스는 “제목/링크/순번/이미지”에만 집중하고,
    - 퀴즈는 “질문/보기/정답 인덱스 검증”에만 집중하게 했다.
    - 카테고리·일차·하루 상태 같은 맥락은 루트에서만 알도록 했다.
3. **초기 버전에서는 DailyContent 중심 API가 대부분이었다.**
    - “카테고리 + 일차로 DailyContent를 조회해서 한 번에 내려준다”가 메인 플로우였고,
    - “뉴스/퀴즈 id만 들고 직접 뭘 한다”는 요구는 거의 없었다.
    - 따라서 처음부터 양방향을 열어두기보다,

      단방향으로 심플하게 시작하는 게 더 낫다고 판단했다.

4. **대신 나중을 위한 확장 플랜은 준비해 두었다.**
    - 자식 기준 요구가 늘어나면 JPA용 역방향(ManyToOne)을 추가하되,

      도메인 규칙이 새 경로로 새는 건 최대한 막을 계획이다.